import { Router } from 'express';
import {asyncMiddleware} from "./Common";
import {RootResolverSchema} from "../Resolvers/RootResolver";
import {ILocation} from "../Location";
import {IDriverFull,IDriverOfFull} from "../Driver";
import {IHTTPResponse} from "../Drivers/HTTPCommon";
import Constructible from "../Constructible";
import {resolve} from "../Resolver";
import * as _ from 'lodash';
import {  } from 'multi-rpc';
import {IScopeContext} from "../Auth/AccessToken";
import RPCServer from "../RPC";

export async function getHttpResponse<O extends IHTTPResponse, I>(req: any, res: any, location: ILocation): Promise<O> {
    let scopeContext: IScopeContext = req.scopeContext;

    let scope = location.auth || 'rpc.getResponse';
    let scopePair = [ scopeContext.currentScope, scopeContext.currentScopeAccessToken ];
    if (scope !== scopeContext.currentScope)
        scopePair = (await (await scopeContext.user.getAccessTokensForScope(scope)).next()).value;

    location.httpContext = {
        req,
        res,
        scopeContext: req.context
    };

    let Driver = <Constructible<IDriverOfFull<IHTTPResponse|null, Buffer>>>(location.getDriver());
    let driver = new Driver();

    let response: IHTTPResponse|null;
    if (req.method === 'GET')
        response = await driver.get(location);
    else if (req.method === 'HEAD')
        response = await driver.head(location);
    else if (req.method === 'PUT')
        response = await driver.put(location, req.body);
    else if (req.method === 'DELETE')
        response = await driver.delete(location);
    else if (req.method === 'CONNECT')
        response = await driver.proxy(location);
    else {
        response = {
            method: req.method,
            status: 405,
            href: location.href
        };
    }

    return response as O;
}

RPCServer.methods.getHttpResponse = async function getHttpResponseRpc<O extends IHTTPResponse, I>(location: ILocation): Promise<O> {
    let { req, res } = this.clientRequest.additionalData;
    return getHttpResponse<O,I>(req, res, location);
}

export default function ResolverMiddleware(req: any, res: any, next: any) {
    asyncMiddleware(async function (req: any, res: any) {
        if (req.originalUrl.substr(0, 5) === '/auth')
            return true;
        let href = ((req.headers && req.headers['x-forwarded-proto']) || req.protocol) + '://' + req.get('host') + req.originalUrl;

        const location = await resolve({ href });

        if (_.isEmpty(location) || !location) {
            return true;
        }

        const response = await getHttpResponse<IHTTPResponse, Buffer>(req, res, location);

        if (!response) {
            return;
        }

        res.status(response.status);
        if (response.headers) {
            for (let k of Array.from(response.headers.keys())) {
                res.set(k, response.headers.get(k));
            }
        }
        if (response.body) {
            res.send(response.body);
        }

        res.end();
    })(req, res, next);
}