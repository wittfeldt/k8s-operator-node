import * as Async from 'async';
import * as FS from 'fs';
import * as YAML from 'js-yaml';
import * as k8s from '@kubernetes/client-node';
import * as request from 'request-promise-native';
import { KubernetesObject } from '@kubernetes/client-node';

/**
 * Base class for an operator.
 */
export default abstract class Operator {
    protected kubeConfig: k8s.KubeConfig;
    protected k8sApi: k8s.CoreV1Api;
    protected k8sExtensionsApi: k8s.ApiextensionsV1beta1Api;

    private _logger: IOperatorLogger;
    private _statusPathBuilders: { [id: string]: (meta: IResourceMeta) => string; } = {};
    private _watchRequests: { [id: string]: any; } = {};
    private _eventQueue: Async.AsyncQueue<{ event: IResourceEvent, onEvent: (event: IResourceEvent) => Promise<void> }>;

    /**
     * Constructs an operator.
     */
    constructor(logger?: IOperatorLogger) {
        this.kubeConfig = new k8s.KubeConfig();
        this.kubeConfig.loadFromDefault();
        this.k8sApi = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
        this.k8sExtensionsApi = this.kubeConfig.makeApiClient(k8s.ApiextensionsV1beta1Api);
        this._logger = logger || new NullLogger();

        // Use an async queue to make sure we treat each incoming event sequentially using async/await
        this._eventQueue = Async.queue<{ onEvent: (event: IResourceEvent) => Promise<void>, event: IResourceEvent }>(
            async (args) => await args.onEvent(args.event));
    }

    /**
     * Run the operator, typically called from main().
     */
    public async start() {
        await this.init();
    }

    public stop() {
        for (const req of Object.values(this._watchRequests)) {
            req.abort();
        }
    }

    /**
     * Initialize the operator, add your resource watchers here.
     */
    protected abstract async init(): Promise<void>;

    /**
     * Register a custom resource defintion.
     * @param crdFile The path to the custom resource definition's YAML file
     */
    protected async registerCustomResourceDefinition(crdFile: string): Promise<{ group: string, versions: any, plural: string }> {
        const crd = YAML.load(FS.readFileSync(crdFile, 'utf8'));
        try {
            await this.k8sExtensionsApi.createCustomResourceDefinition(crd as k8s.V1beta1CustomResourceDefinition);
            this._logger.info(`registered custom resource definition '${crd.metadata.name}'`);
        } catch (err) {
            // API returns a 409 Conflict if CRD already exists.
            if (err.response.statusCode !== 409) {
                throw err;
            }
        }
        return { group: crd.spec.group, versions: crd.spec.versions, plural: crd.spec.names.plural };
    }

    /**
     * Get uri to the API for your custom resource.
     * @param group The group of the custom resource
     * @param version The version of the custom resource
     * @param plural The plural name of the custom resource
     * @param namespace Optional namespace to include in the uri
     */
    protected getCustomResourceApiUri(group: string, version: string, plural: string, namespace?: string): string {
        let path = group ? `/apis/${group}/${version}/` : `/api/${version}/`;
        if (namespace) {
            path += `namespaces/${namespace}/`;
        }
        path += plural;
        return this.k8sApi.basePath + path;
    }

    /**
     * Watch a Kubernetes resource.
     * @param group The group of the resource or an empty string for core resources
     * @param version The version of the resource
     * @param plural The plural name of the resource
     * @param onEvent The async callback for added, modified or deleted events on the resource
     */
    protected async watchResource(group: string, version: string, plural: string, onEvent: (event: IResourceEvent) => Promise<void>) {
        const apiVersion = group ? `${group}/${version}` : `${version}`;
        const id = `${plural}.${apiVersion}`;

        this._statusPathBuilders[id] = (meta: IResourceMeta) => this.getCustomResourceApiUri(group, version, plural, meta.namespace) + `/${meta.name}/status`;

        //
        // Create "infinite" watch so we automatically recover in case the stream stops or gives an error.
        //
        const uri = group ? `/apis/${group}/${version}/${plural}` : `/api/${version}/${plural}`;
        const watch = new k8s.Watch(this.kubeConfig);

        const startWatch = () => this._watchRequests[id] = watch.watch(uri, {},
            (type, obj) => this._eventQueue.push({
                event: {
                    meta: ResourceMeta.createWithPlural(plural, obj),
                    object: obj,
                    type: type as ResourceEventType
                },
                onEvent
            }),
            (err: any) => {
                if (err) {
                    this._logger.warn(`restarting watch on resource ${id} (reason: ${JSON.stringify(err)})`);
                }
                setTimeout(startWatch, 100);
            });
        startWatch();

        this._logger.info(`watching resource ${id}`);
    }

    /**
     * Set the status subresource of a custom resource (if it has one defined).
     * @param meta The resource to update
     * @param status The status body to set
     */
    protected async setResourceStatus(meta: IResourceMeta, status: any): Promise<IResourceMeta> {
        const requestOptions: request.Options = this.buildResourceStatusRequest(meta, status, false);
        const responseBody = await request.put(requestOptions, (error, res, _) => {
            if (error) {
                this._logger.error(error.message || JSON.stringify(error));
                return '';
            }
        });
        return ResourceMeta.createWithId(meta.id, JSON.parse(responseBody));
    }

    /**
     * Patch the status subresource of a custom resource (if it has one defined).
     * @param meta The resource to update
     * @param status The status body to set in JSON Merge Patch format (https://tools.ietf.org/html/rfc7386)
     */
    protected async patchResourceStatus(meta: IResourceMeta, status: any): Promise<IResourceMeta> {
        try {
            const requestOptions = this.buildResourceStatusRequest(meta, status, true);
            const responseBody = await request.patch(requestOptions, (error, res, _) => {
                if (error) {
                    this._logger.error(error.message || JSON.stringify(error));
                    return '';
                }
            });
            return ResourceMeta.createWithId(meta.id, JSON.parse(responseBody));
        } catch (error) {
            throw error;
        }
    }

    private buildResourceStatusRequest(meta: IResourceMeta, status: any, isPatch: boolean): request.Options {
        const body: any = {
            apiVersion: meta.apiVersion,
            kind: meta.kind,
            metadata: {
                name: meta.name,
                resourceVersion: meta.resourceVersion
            },
            status
        };
        if (meta.namespace) {
            body.metadata.namespace = meta.namespace;
        }
        const requestOptions: request.Options = {
            body: JSON.stringify(body),
            uri: this._statusPathBuilders[meta.id](meta)
        };
        if (isPatch) {
            requestOptions.headers = {
                'Content-Type': 'application/merge-patch+json'
            };
        }
        this.kubeConfig.applyToRequest(requestOptions);
        return requestOptions;
    }
}

/**
 * An event on a Kubernetes resource.
 */
export interface IResourceEvent {
    meta: IResourceMeta;
    type: ResourceEventType;
    object: KubernetesObject;
}

/**
 * The resource event type.
 */
export enum ResourceEventType {
    Added = 'ADDED',
    Modified = 'MODIFIED',
    Deleted = 'DELETED'
}

/**
 * Some meta information on the resource.
 */
export interface IResourceMeta {
    name: string;
    namespace?: string;
    id: string;
    resourceVersion: string;
    apiVersion: string;
    kind: string;
}

class ResourceMeta implements IResourceMeta {
    public static createWithId(id: string, object: KubernetesObject) {
        return new ResourceMeta(id, object);
    }

    public static createWithPlural(plural: string, object: KubernetesObject) {
        return new ResourceMeta(`${plural}.${object.apiVersion}`, object);
    }

    public id: string;
    public name: string;
    public namespace?: string;
    public resourceVersion: string;
    public apiVersion: string;
    public kind: string;

    private constructor(id: string, object: KubernetesObject) {
        if (!object.metadata
            || !object.metadata.name
            || !object.metadata.resourceVersion
            || !object.apiVersion
            || !object.kind) {
            throw Error(`Malformed event object for '${id}'`);
        }
        this.id = id;
        this.name = object.metadata.name;
        this.namespace = object.metadata.namespace;
        this.resourceVersion = object.metadata.resourceVersion;
        this.apiVersion = object.apiVersion!;
        this.kind = object.kind!;
    }
}

/**
 * Logger interface.
 */
export interface IOperatorLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

class NullLogger implements IOperatorLogger {
    // tslint:disable-next-line: no-empty
    public info(message: string): void { }
    // tslint:disable-next-line: no-empty
    public warn(message: string): void { }
    // tslint:disable-next-line: no-empty
    public error(message: string): void { }
}
