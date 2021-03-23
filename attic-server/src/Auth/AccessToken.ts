import {Document, Schema} from 'mongoose';
import mongoose from '../Database';
import {ObjectId} from 'mongodb';
import IAccessTokenBase, {IFormalAccessToken, TokenTypes} from "@znetstar/attic-common/lib/IAccessToken";
import User, {isAuthorizedToDo, IUser} from "../User";
import Client, {IClient} from "./Client";
import * as _ from 'lodash';
import {IClientRole} from "@znetstar/attic-common/lib/IClient";
import * as URL from "url";
import fetch from "node-fetch";
import {nanoid} from "nanoid";
import config from "../Config";
import {
    CouldNotFindTokenForScopeError,
    NotAuthorizedToUseScopesError
} from "@znetstar/attic-common/lib/Error/AccessToken";

export {IFormalAccessToken} from "@znetstar/attic-common/lib/IAccessToken";

export interface IAccessTokenModel {
    id: ObjectId;
    _id: ObjectId;
    user?: IUser;
    client: IClient;
    updatedAt: Date,
    createdAt: Date,
    linkedToken: IAccessToken|ObjectId,
    isAuthorizedToDo(scope: string|Function): boolean;
    toFormalToken(): Promise<IFormalAccessToken>;
    accessTokenFromRefresh(): Promise<IAccessToken&Document>;
    clientRole: IClientRole;
    formalScope: string[];
    authorizationHeader: string|null;
    clientName?: string;
}


export interface IScopeContext {
    currentScope?: string;
    currentScopeAccessToken?: IAccessToken;
    accessToken?: IAccessToken;
    user?: IUser;
}

export type IAccessToken = IAccessTokenBase&IAccessTokenModel;

export const AccessTokenSchema = <Schema<IAccessToken>>(new (mongoose.Schema)({
    tokenType: {
        type: String,
        enum: [ 'bearer', 'refresh_token' ]
    },
    token: {
        type: String
    },
    linkedToken: {
        ref: 'AccessToken',
        type: Schema.Types.ObjectId,
        required: false
    },
    expiresAt: {
        type: Date
    },
    scope: {
        type: [String]
    },
    user: {
        ref: 'User',
        type: Schema.Types.ObjectId,
        required: false
    },
    client: {
        ref: 'Client',
        type: Schema.Types.ObjectId,
        required: true
    },
    clientRole: {
        type: String,
        required: true,
        enum: Object.keys(require('@znetstar/attic-common/lib/IClient').IClientRole)
    },
    clientName: {
        type: String,
        required: false
    }
}, {
    collection: 'access_tokens',
    timestamps: true
}));

AccessTokenSchema.pre<IAccessToken&Document>('save', async function (){
   let client = await Client.findById(this.client).exec();

   this.clientName = client.name;
   if (this.clientRole === IClientRole.provider && this.scope.length) {
       this.scope = this.scope.map((s: string) => `${client.name}.${s}`);
   }

    if (this.tokenType === 'bearer' && client.expireAccessTokenIn !== null) {
        return (new Date()).getTime() + (typeof(client.expireAccessTokenIn) !== 'undefined' ? client.expireAccessTokenIn : config.expireTokenIn);
    } else if (this.tokenType === 'refresh_token' && client.expireRefreshTokenIn !== null) {
        return (new Date()).getTime() + (typeof(client.expireRefreshTokenIn) !== 'undefined' ? client.expireRefreshTokenIn : config.expireRefreshTokenIn);
    }

   if (!this.user)
       return;

   let user = await User.findById(this.user).exec();

  if (this.clientRole === IClientRole.consumer) {
      let { unauthorizedScopes } = getValidInvalidScopes(this.scope, client, user);
      for await (let token of user.getAccessTokensForScope(unauthorizedScopes)) {
        if (!token || !token[1]) {
            throw new CouldNotFindTokenForScopeError(token);
        }
      }
  }
});

export function checkScopePermission(scopes: string[], client: IClient, user:IUser): string[] {
    const { validScopes, unauthorizedScopes } = getValidInvalidScopes(scopes, client, user);
    if (unauthorizedScopes.length) {
        throw new NotAuthorizedToUseScopesError(unauthorizedScopes);
    }
    return validScopes;
}

export function getValidInvalidScopes(scopes: string[], client: IClient, user: IUser) {
    let unauthorizedScopes: string[] = [], validScopes: string[] = [];
    for (let singleScope of scopes) {
        if (_.isEmpty(singleScope)) continue;
        if (isAuthorizedToDo(user.scope, singleScope) || isAuthorizedToDo(client.scope, singleScope)) {
            validScopes.push(singleScope);
        } else {
            unauthorizedScopes.push(singleScope);
        }
    }

    return { unauthorizedScopes, validScopes };
}

AccessTokenSchema.post('save', async function (doc: IAccessToken&Document){
    if (doc.tokenType === TokenTypes.Bearer && doc.linkedToken) {
        await AccessToken.deleteMany({ tokenType: TokenTypes.Bearer, linkedToken: doc.linkedToken, _id: { $ne: doc._id } });
    }
});

AccessTokenSchema.virtual('authorizationHeader')
    .get(function () {
        if (this.tokenType === TokenTypes.Bearer) {
            return `Bearer ${this.token}`;
        }

        return null;
    });

AccessTokenSchema.virtual('formalScope').get(function () {
    if (this.clientRole === 'provider') {
        return this.scope.map((s: string) => s.replace(new RegExp('$'+this.clientName), ''));
    }
    return this.scope;
})

export const AccessToken = mongoose.model<IAccessToken&Document>('AccessToken', AccessTokenSchema);
export default AccessToken;

AccessTokenSchema.methods.isAuthorizedToDo = function (scope: string|Function) {
    if (typeof(scope) === 'function')
        scope = scope.name;

    return this.scope.includes(scope);
};

AccessTokenSchema.methods.toFormalToken = function (): Promise<IFormalAccessToken> {
    return toFormalToken(this);
}

AccessTokenSchema.methods.accessTokenFromRefresh = async function (): Promise<IAccessToken&Document|null> {
    let self: IAccessToken&Document = this;
    let refreshToken = self.tokenType === TokenTypes.RefreshToken ? self : (self.linkedToken ? (await AccessToken.findById(self.linkedToken)) : null);

    if (!refreshToken) return null;
    if (self.clientRole === IClientRole.provider) {
        let client =  await Client.findById(self.client).exec();

        if (!client)
            return null;

        let q = {
            grant_type: 'refresh_token',
            refresh_token: refreshToken.token,
            redirect_uri: client.redirectUri,
            client_id: client.clientId,
            client_secret: client.clientSecret
        }

        const params = new URL.URLSearchParams();

        for (let k in q) params.append(k, (q as any)[k]);

        let tokenUri: any = URL.parse(client.tokenUri, true);
        tokenUri.query = q;
        tokenUri = URL.format(tokenUri);

        let tokenResp = await fetch(tokenUri, {
            method: 'POST',
            body: params
        });

        if (tokenResp.status !== 200) {
            return null;
        }

        let user = await User.findById(self.user).exec();

        let formalToken: IFormalAccessToken = await tokenResp.json();
        let { accessToken, refreshToken: newRefreshToken } = await fromFormalToken(formalToken, user, client, IClientRole.provider);
        accessToken.save();
        if (newRefreshToken) {
            await self.remove();
            await newRefreshToken.save();
        }

        return accessToken;
    } else if (self.clientRole === IClientRole.consumer) {

        let accessToken = new AccessToken({
            tokenType: 'bearer',
            token: nanoid(),
            expiresAt: (new Date()).getTime() + config.expireTokenIn,
            linkedToken: self._id,
            scope: self.scope,
            client: self.client,
            clientRole: IClientRole.consumer,
            clientName: self.clientName,
            user: self.user
        });

        await accessToken.save();
        return accessToken;
    }

    return null;
}

export function fromFormalToken(formalToken: IFormalAccessToken, user: ObjectId|IUser|null, client: IClient, role: IClientRole): { accessToken: IAccessToken&Document, refreshToken?: IAccessToken&Document } {
    let accessToken = new AccessToken({
        token: formalToken.access_token,
        expiresAt: formalToken.expires_in ? ((new Date().getTime()) + (formalToken.expires_in)*1e3) : void(0),
        scope: formalToken.scope ? formalToken.scope.split(' ') : void(0),
        user,
        client,
        tokenType: 'bearer',
        clientRole: role,
        clientName: client.name
    });

    let refreshToken;

    if (formalToken.refresh_token) {
        refreshToken = new AccessToken({
            token: formalToken.refresh_token,
            scope: formalToken.scope ? formalToken.scope.split(' ') : void(0),
            user,
            client,
            tokenType: 'refresh_token',
            linkedToken: accessToken._id,
            clientRole: role,
            clientName: client.name
        });

        accessToken.linkedToken = refreshToken._id;
    }


    return {
        refreshToken,
        accessToken
    }
}

export async function toFormalToken(accessTokenQuery: IAccessToken|ObjectId|string): Promise<IFormalAccessToken> {
    let token: IAccessToken;
    if (typeof(accessTokenQuery) === 'string' || !(accessTokenQuery as any)._id) {
        token = await AccessToken.findById(accessTokenQuery);
    } else {
        token = accessTokenQuery as IAccessToken;
    }

    if (!token) return null;

    let linkedToken: IAccessToken = await AccessToken.findById(token.linkedToken).exec();
    let refreshToken: IAccessToken = token.tokenType === TokenTypes.RefreshToken ? token : linkedToken;
    let accessToken: IAccessToken = token.tokenType !== TokenTypes.RefreshToken ? token : linkedToken;

    let formalToken: IFormalAccessToken = {
        access_token: _.get(accessToken, 'token'),
        refresh_token: _.get(refreshToken, 'token'),
        scope: token.formalScope.join(' '),
        expires_in: _.get(token, 'expiresAt') ? Math.round(((_.get(token, 'expiresAt').getTime() - (new Date()).getTime())/1e3)) : void(0),
        token_type: _.get(token, 'tokenType')
    }

    return formalToken;
}

AccessTokenSchema.methods.isAuthorizedToDo = function (scope: string) {
    let regexes = this.scope.map((x: string) => {
        if (x[0] !== '/')
            return new RegExp(x);

        let regex = x.split('/');
        let options = regex.slice(regex.length - 1)[0];
        regex = regex.slice(1, regex.length - 1);

        return new RegExp(regex.join('/'), options);
    })

    for (let regex of regexes) {
        if (regex.test(scope)) return true;
    }

    return false;
};


AccessToken.collection.createIndex({
    expiresAt: 1
}, {
    expireAfterSeconds: 0
});