import isUrl from "is-url";
import url from "url";
import sim, { AccessToken, AuthorizationCode } from "simple-oauth2";
import joinUrl from "proper-url-join";
import pkg from "./package.json";
import queryString from "query-string";
import axios from "axios";

function rejectValidation(module, param) {
	return Promise.reject({
		status: 0,
		message: "The " + module + " " + param + " is not valid or it was not specified properly"
	})
};

const defaultAssetsNumberPerPage = 50;

class ApiCall {
	baseUrl: string;
	httpsAgent: string;
	httpAgent: string;
	token: AccessToken | undefined;
	permanentToken: string | undefined = undefined;
	data: ApiBody;

	constructor(baseUrl: string, httpsAgent: string, httpAgent: string, token: AccessToken | undefined = undefined) {
		if (!isUrl(baseUrl)) throw new Error("The base URL provided is not valid");

		this.baseUrl = baseUrl;
		this.httpsAgent = httpsAgent;
		this.httpAgent = httpAgent;
		this.token = token;
	}

	async send(method: HTTPMethod, url: string, data: ApiBody = {}) {
		let callURL = joinUrl(this.baseUrl, url, { trailingSlash: true });

		if (!(this.token || this.permanentToken)) {
			throw new Error("No token found");
		}

		const headers = {
			'User-Agent': "bynder-js-sdk/" + pkg.version
		}

		if (!this.permanentToken && this.token) {
			if (this.token.expired()) {
				this.token = await this.token.refresh();
			}

			headers["Authorization"] = "Bearer " + this.token.token.access_token;
		} else {
			let body = "";

			headers["Authorization"] = "Bearer " + this.permanentToken;

			if (method === "POST") {
				headers["Content-Type"] = "application/x-www-form-urlencoded";

				body = queryString.stringify(data);
			} else if (Object.keys(data).length && data.constructor === Object) {
				callURL = joinUrl(callURL, { trailingSlash: true, query: data });
			}

			return await axios(callURL, {
				httpsAgent: this.httpsAgent,
				httpAgent: this.httpAgent,
				method: method,
				data: body,
				headers: headers
			}).then((response) => {
				if (response.status >= 400) {
					return Promise.reject({
						status: response.status,
						message: response.statusText,
						body: response.data
					});
				}

				if (response.status >= 200 && response.status <= 202) {
					return response.data;
				}

				return {};
			})
		}
	}
}

type Options = {
	baseUrl: string,
	httpsAgent: string,
	httpAgent: string,
	clientId: string,
	clientSecret: string;
	[key: string]: any;
}

type GetMediaListParams = {
	propertyOptionId?: string | string[]
	[key: string]: any
}

type GetMediaInfoParams = {
	id?: string,
	versions?: boolean;
	[key: string]: any
}

type ApiBody = { [k: string]: string | number | readonly (string | number)[]; };

type HTTPMethod = "POST" | "GET" | "PUT" | "DELETE";

class Bynder {
	api: ApiCall;
	oauth2AuthorizationCode: AuthorizationCode;
	redirectUri: string;

	constructor(options: Options) {
		const { baseUrl, httpsAgent, httpAgent, clientId, clientSecret, permanentToken, token, redirectUri } = options;

		this.redirectUri = redirectUri;

		this.api = new ApiCall(baseUrl, httpsAgent, httpAgent);

		if (typeof permanentToken === 'string') {
			this.api.permanentToken = permanentToken;
		}

		const oauthBaseUrl = new URL(baseUrl, "/v6/authentication").toString();

		this.oauth2AuthorizationCode = new AuthorizationCode({
			client: {
				id: options.clientId,
				secret: options.clientSecret
			},
			auth: {
				tokenHost: oauthBaseUrl,
				tokenPath: "oauth2/token",
				revokePath: "oauth2/revoke",
				authorizeHost: oauthBaseUrl,
				authorizePath: "oauth2/auth"
			}
		});

		if (token) {
			if (typeof token.access._token !== "string") {
				throw new Error("Invalid token format: " + JSON.stringify(token, null, 2));
			}

			this.api.token = this.oauth2AuthorizationCode.createToken(token);
		}
	}

	makeAuthorizationUrl(state: string, scope: string) {
		return this.oauth2AuthorizationCode.authorizeURL({
			redirect_uri: this.redirectUri,
			scope: scope,
			state: state
		})
	}

	async getToken(code: string) {
		const tokenConfig = {
			code: code,
			redirect_uri: this.redirectUri
		};

		const accessToken = await this.oauth2AuthorizationCode.getToken(tokenConfig);

		const token = this.oauth2AuthorizationCode.createToken(accessToken.token);

		this.api.token = token;

		return token;
	}

	async getSmartFilters() {
		return this.api.send("GET", "v4/smartfilters/");
	}

	async userLogin(params: {
		username: string,
		password: string,
		consumerId: string
	}) {
		if (!params.username || !params.password || !params.consumerId) {
			return rejectValidation("authentication", "username, password or consumerId");
		}

		return this.api.send("POST", "v4/users/login/", params);
	}

	async getMediaList(params: GetMediaListParams = {}) {
		const { propertyOptionId } = params;

		return this.api.send("GET", "v4/media/", {
			...params,
			count: false.toString(),
			propertyOptionId: Array.isArray(propertyOptionId) ? propertyOptionId.join(",") : ""
		})
	}

	async getMediaInfo({ id, ...options } = { id: undefined }) {
		if (!id) {
			return rejectValidation("media", "id");
		}

		return this.api.send("GET", "v4/media/" + id + "/", options);
	}

	async getAllMediaItems(params: Object) {
		const recursiveGetAssets = async (_params: { page?: number, limit?: number } = {}, assets: any[]) => {
			let queryAssets = assets;
			const params = { ..._params };
			params.page = !params.page ? 1 : params.page;
			params.limit = !params.limit ? defaultAssetsNumberPerPage : params.limit;

			try {
				const mediaList = await this.getMediaList(params)

				queryAssets = assets.concat(mediaList);
				if (mediaList && mediaList.length === params.limit) {
					// If the results page is full it means another one might exist
					params.page += 1;
					return recursiveGetAssets(params, queryAssets);
				}

				return queryAssets;
			} catch (err) {
				return err;
			}
		};

		return recursiveGetAssets(params, []);
	}

	async getMediaTotal(params: { propertyOptionId?: string | string[] } = {}) {
		const parametersObject = {
			...params,
			count: true.toString()
		};

		if (Array.isArray(parametersObject.propertyOptionId)) {
			parametersObject.propertyOptionId = parametersObject.propertyOptionId.join();
		}

		const data = await this.api.send("GET", "v4/media/", parametersObject);
		return data.count.total;
	}

	editMedia(params: { id?: string } = {}) {
		if (!params.id) {
			return rejectValidation("media", "id");
		}

		return this.api.send("POST", "v4/media", params);
	}

	deleteMedia(params: { id: string }) {
		return this.api.send("DELETE", `v4/media/${params.id}/`);
	}

	async getMetaProperties(params: ApiBody = {}) {
		const data = await this.api.send("GET", "v4/metaproperties/", params);
		return Object.keys(data).map((metaproperty) => {
			return data[metaproperty];
		});
	}

	getMetaproperty(params: { id?: string } = {}) {
		const { id } = params;

		if (!id) {
			return rejectValidation("metaproperty", "id");
		}
		return this.api.send("GET", `v4/metaproperties/${id}/`);
	}

	saveNewMetaProperty(params: object = {}) {
		return this.api.send("POST", "v4/metaproperties", {
			data: JSON.stringify(params)
		});
	}

	editMetaproperty(params: { id?: string } = {}) {
		const { id } = params;

		if (!id) {
			return rejectValidation("metaproperty", "id");
		}
		return this.api.send("POST", `v4/metaproperties/${id}/`, {
			data: JSON.stringify(params)
		});
	}

	deleteMetaProperty(params: { id?: string } = {}) {
		const { id } = params;

		if (!id) {
			return rejectValidation("metaproperty", "id");
		}

		return this.api.send("DELETE", `v4/metaproperties/${id}/`);
	}

	saveNewMetaPropertyOption(params: { id?: string, name?: string } = {}) {
		const { id, name } = params;

		if (!id || !params.name) {
			return rejectValidation("metaproperty option", "id or name");
		}

		return this.api.send("POST", "v4/metaproperties/" + `${id}/options/`, {
			data: JSON.stringify(params)
		});
	}

	editMetaPropertyOption(params: { id?: string, optionId?: string, name?: string } = {}) {
		const { id, optionId, name } = params;

		if (!id || !optionId) {
			return rejectValidation("metaproperty option", "id or optionId");
		}

		return this.api.send("POST", `v4/metaproperties/${id}/options/${optionId}/`, { data: JSON.stringify(params) });
	}
}