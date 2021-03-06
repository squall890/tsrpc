import * as Express from 'express';
import ApiRequest from './models/ApiRequest';
import ApiResponse from './models/ApiResponse';
import ApiRequestExtend from './middlewares/ApiRequestExtend';
import ServerConfig from './models/ServerConfig';
import { DefaultServerConfig } from './models/ServerConfig';
import ApiHandler from './models/ApiHandler';
import ApiResponseExtend from './middlewares/ApiResponseExtend';
import ValidatorManager, { IValidator } from 'ts-interface-validator';
import { TsrpcPtl, TsrpcReq, TsrpcRes, TsrpcError } from 'tsrpc-protocol';
import * as http from 'http';
import AutoImplementProtocol from './models/AutoImplementProtocol';
import EnableLog4js from './models/EnableLog4js';
import 'k8w-extend-native';
import * as bodyParser from 'body-parser';

export type RouterHandler = (req: ApiRequest<any>, res: ApiResponse<any>, next: () => void) => any;

export type ExpressApplication = Overwrite<Express.Application, { use: (...handlers: RouterHandler[]) => void }>;

export default class TsrpcServer {
    readonly config: ServerConfig;

    constructor(conf: Partial<ServerConfig> & { protocolPath: string }) {
        this.config = Object.merge({}, DefaultServerConfig, conf);

        //urlRootPath must ends with /
        if (!this.config.urlRootPath.endsWith('/')) {
            this.config.urlRootPath += '/';
        }

        //Enable log4js
        if (this.config.logFiles) {
            EnableLog4js(this.config.logFiles);
        }

        //auto implement protocol
        if (this.config.autoImplement) {
            if (!this.config.apiPath) {
                throw new Error('Must set apiPath when autoImplement is enabled')
            }

            console.log('Start auto implement protocol...');
            let result = AutoImplementProtocol(this, this.config.protocolPath, this.config.apiPath);
            if (result == null) {
                console.log('Auto implement protocol succ')
            }
            else {
                throw new Error('Auto implement protocol failed:\n' + result.map((v, i) => `    ${i + 1}. ` + v).join('\n'))
            }
        }
    }

    protected _implementedUrl: {
        [rpcUrl: string]: {
            protocol: TsrpcPtl<any, any>,
            handler: ApiHandler<any, any>,
            reqValidator: IValidator
        }
    } = {};
    /**
     * Implement PtlXXX by ApiXXX
     * @param protocol PtlXXX
     * @param handler ApiXXX
     */
    implementPtl<Req, Res>(protocol: TsrpcPtl<Req, Res>, handler: ApiHandler<Req, Res>) {
        let url = this.getPtlUrl(protocol);        
        //duplicate warn
        if (this._implementedUrl[url]) {
            console.warn('You are implementing a duplicated protocol: ' + protocol.filename, 'url=' + url);
        }
        //get request validator
        let reqValidator = ValidatorManager.instance.getValidator('Req' + protocol.name, protocol.filename.replace(/\.js$/, '.ts'));
        //do register
        this._implementedUrl[url] = {
            protocol: protocol,
            handler: handler,
            reqValidator: reqValidator
        }

        console.log('Protocol registered succ: ', url, protocol.filename);
    }

    /**
     * Get rpcUrl of protocol
     * Without `/` at the beginning and the end
     * @param ptl 
     */
    private getPtlUrl(ptl: TsrpcPtl<any, any>): string {
        let filename = ptl.filename.replace(/\.js$/, '.ts');
        if (!filename.startsWith(this.config.protocolPath) || !filename.endsWith('.ts')) {
            throw new Error('Protocol is not in the protocolPath : ' + filename);
        }
        return filename.substr(this.config.protocolPath.length, filename.length - this.config.protocolPath.length - 3)  // /root/a/b/PtlC.ts -> /a/b/PtlC
            .replace(/\\/g, '/').replace(/Ptl(\w+)$/, '$1'); // /a/b/PtlC -> /a/b/C
    }

    private _expressApp!: ExpressApplication;
    private init() {
        if (this._expressApp) {
            return;
        }

        //new express app
        let expressApp: ExpressApplication = Express() as any;
        this._expressApp = expressApp;

        //the frontest init
        //optimize useless header
        expressApp.disable('x-powered-by');
        //show real IP
        expressApp.set('trust proxy', true);

        //parse body
        expressApp.use((this.config.binaryTransport ? bodyParser.raw : bodyParser.text)({
            limit: Infinity,
            type: req => {
                let type = req.headers['content-type'];
                //当multipart/form-data时，不解析body（上传的情况）
                return !(type && type.startsWith('multipart/form-data'));
            }
        }))
        //extend rpcServer for req and res
        expressApp.use((req: ApiRequest<any>, res: ApiResponse<any>, next) => {
            req.rpcServer = this;
            res.rpcServer = this;
            next();
        });

        //Req extend
        expressApp.use(ApiRequestExtend);
        //Res extend
        expressApp.use(ApiResponseExtend);
        //Check if protocol registered
        expressApp.use((req: ApiRequest<TsrpcReq>, res: ApiResponse<TsrpcRes>, next) => {
            if (!req.args) {
                next();
                return;
            }

            if (this.config.hideApiPath) {
                //__tsrpc_url__ should appear
                if (req.args.__tsrpc_url__ == null) {
                    (res as any).apiPreCheckError = ['HideApiPath is enabled, set it to true too in your client config.', 'REQ_CANT_BE_RESOLVED']
                    next();
                    return;
                }
                req.rpcUrl = req.args.__tsrpc_url__;
                delete req.args.__tsrpc_url__;
            }
            else {
                //__tsrpc_url__ should not appear
                if (req.args.__tsrpc_url__) {
                    (res as any).apiPreCheckError = ['HideApiPath is disabled, set it to false too in your client config.', 'REQ_CANT_BE_RESOLVED']
                    next();
                    return;
                }

                if (req.path.startsWith(this.config.urlRootPath)) {
                    req.rpcUrl = '/' + req.path.substr(this.config.urlRootPath.length);
                }
                else {
                    (res as any).apiPreCheckError = ['Invalid path', 'INVALID_PATH']
                    next();
                    return;
                }
            }

            //Not specify rpcUrl
            if (!req.rpcUrl) {
                (res as any).apiPreCheckError = ['Request cannot be resolved', 'REQ_CANT_BE_RESOLVED']
                next();
                return;
            }

            //OK: Protocol registered
            req.rpcPtl = this._implementedUrl[req.rpcUrl] ? this._implementedUrl[req.rpcUrl].protocol : null as any;
            next();
        });

        //_routerBeforeApiHandler
        expressApp.use(this._routerBeforeApiHandler);

        //api handler (final router)
        expressApp.use(async (req: ApiRequest<any>, res: ApiResponse<any>) => {
            //TODO 如果ApiReq解析失败，则报错
            if (!req.args) {
                console.error('Invalid Request Body', req.url, req.body)
                res.status(400).send('Invalid Request Body');
                return;
            }

            //apiPreCheckError
            if ((res as any).apiPreCheckError) {
                res.error.apply(res, (res as any).apiPreCheckError);
                return;
            }

            //404
            if (!req.rpcPtl) {
                //Error404: no url or protocol not registered
                this.onPtlNotFound(req, res);
                return;
            }

            //log request
            console.log('[ApiReq]', '#' + req.reqId, req.rpcUrl, req.realIp, this.config.logRequestDetail ? req.args : '');

            //validate request
            let validateResult = this._implementedUrl[req.rpcUrl].reqValidator.validate(req.args);
            if (validateResult.isError) {
                let originalError = validateResult.originalError;
                let reason = this.config.showParamInvalidReason ? (originalError.fieldName + ': ' + originalError.message) : 'Invalid Request Parameter';
                console.warn('Invalid Request Parameter', req.rpcUrl, originalError.fieldName + ': ' + originalError.message);
                res.error(reason, 'INVALID_REQ_PARAM');
                return;
            }

            //do handler
            try {
                let result = await this._implementedUrl[req.rpcUrl].handler(req, res);
            }
            catch (e) {
                //TsrpcError is return to client directly
                if (e instanceof TsrpcError) {
                    res.error(e.message, e.info);
                }
                else {
                    this.onUnhandledApiError(e, req, res);
                }
            }

            //complete event (succ or error)
            this.onApiComplete && this.onApiComplete(req, res);
        })

        console.log('TSRPC inited succ')
    }

    private _server!: http.Server;
    async start(port?: number) {
        this.init();
        port = port || this.config.defaultPort;

        return new Promise<void>((rs, rj) => {
            try {
                this._server = this._expressApp.listen(port, () => {
                    console.log(`Server started at ${port}...`)
                    rs();
                });
            }
            catch (e) {
                console.error(`Port ${port} is already in use.`)
                rj(e);
            }

        })
    }

    stop() {
        this._server && this._server.close()
        delete this._server;
    }

    //get、post、use it will use before api handler
    private _routerBeforeApiHandler = Express.Router();
    use(handler: RouterHandler): void;
    use(path: string, handler: RouterHandler): void;
    use() {
        this._routerBeforeApiHandler.use.apply(this._routerBeforeApiHandler, arguments);
    }
    get(handler: RouterHandler): void;
    get(path: string, handler: RouterHandler): void;
    get() {
        this._routerBeforeApiHandler.get.apply(this._routerBeforeApiHandler, arguments);
    }
    post(handler: RouterHandler): void;
    post(path: string, handler: RouterHandler): void;
    post() {
        this._routerBeforeApiHandler.post.apply(this._routerBeforeApiHandler, arguments);
    }

    //hooks
    onPtlNotFound(req: ApiRequest<any>, res: ApiResponse<any>) {
        res.error('404 Not Found', 'PTL_NOT_FOUND');
    };
    onUnhandledApiError(err: Error, req: ApiRequest<any>, res: ApiResponse<any>) {
        console.error(req.rpcUrl, req.args, err);
        res.error('Internal Server Error', 'UNHANDLED_API_ERROR');
    };
    onApiComplete?: (req: ApiRequest<any>, output: ApiResponse<any>) => {};
}