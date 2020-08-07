import axios, { AxiosRequestConfig, Method } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { random } from 'faker';
import { APIGatewayEvent } from 'aws-lambda';
import {
  findMatchingRoutingRule,
  replacePathParameters,
  buildParams,
  forward,
  proxy,
  handleProxiedRequest,
  buildHeaders,
  buildData,
  ProxiedRouteRule,
  HttpResponse,
} from '../lib';

const mockHttpClient = new MockAdapter(axios);
const userId = random.uuid();

afterEach(() => {
  mockHttpClient.reset();
});

describe('findMatchingRoutingRule', () => {
  const event = {
    resource: '/matching-route/1234',
    httpMethod: 'GET',
  } as APIGatewayEvent;

  test('route rule matches event when url and method match', () => {
    const rule = {
      incomingRequest: {
        path: '/matching-route/:param',
        method: 'GET' as Method,
      },
      upstreamRequest: {},
    };
    const matchingRule = findMatchingRoutingRule(event, [rule]);
    expect(matchingRule).toEqual(rule);
  });

  test('route rule matches when url matches and incoming method is falsy', () => {
    const rule = {
      incomingRequest: {
        path: '/matching-route/:param',
      },
      upstreamRequest: {},
    };
    const matchingRule = findMatchingRoutingRule(event, [rule]);
    expect(matchingRule).toEqual(rule);
  });

  test('route rule does not match when event resource is differs from incoming url regex', async () => {
    const rule = {
      incomingRequest: {
        path: '/not-matching-route/:param',
      },
      upstreamRequest: {},
    };
    const matchingRule = findMatchingRoutingRule(event, [rule]);
    expect(matchingRule).toBeUndefined();
  });

  test('route rule does not match when http methods are different', async () => {
    const rule = {
      incomingRequest: {
        path: '/matching-route/:param',
        method: 'OPTIONS' as Method,
      },
      upstreamRequest: {},
    };
    const matchingRule = findMatchingRoutingRule(event, [rule]);
    expect(matchingRule).toBeUndefined();
  });
});

describe('replacePathParameters', () => {

  test('replace path parameter placeholders with values', () => {
    const event = {
      requestContext: {
        authorizer: {
          claims: {
            sub: userId
          }
        }
      }
    } as unknown;
    return replacePathParameters(
      event as APIGatewayEvent,
      '/person/:userId/shipping-address/:shippingAddressId',
      {
        userId: event => event?.requestContext?.authorizer?.claims?.sub,
        shippingAddressId: '1'
      }
    ).then(res => {
      expect(res).toEqual(`/person/${userId}/shipping-address/1`);
    });
  });
});

describe('buildParams', () => {

  test('build querystring parameters from event and upstreamRequest params', () => {
    const event = {
      requestContext: {
        authorizer: {
          claims:{
            sub: userId
          }
        }
      },
      queryStringParameters: {
        search: 'text'
      },
    } as unknown;
    const result = buildParams(
      event as APIGatewayEvent,
      {
        upstreamRequest: {
          params: {
            userId: (event: APIGatewayEvent) => event?.requestContext?.authorizer?.claims?.sub,
            size: 1
          }
        }
      }
    );
    expect(result).toEqual({
      search: 'text',
      size: 1,
      userId,
    });
  });
});

describe('buildHeaders', () => {
  test('build headers from upstreamRequest headers', () => {
    const userId = 'user-id';
    const event = {
      requestContext: {
        authorizer: {
          claims:{
            sub: userId
          }
        }
      },
      headers: {
        search: 'text'
      },
    } as unknown;
    const result = buildHeaders(
      event as APIGatewayEvent,
      {
        upstreamRequest: {
          headers: {
            userId: (event: APIGatewayEvent) => event?.requestContext?.authorizer?.claims?.sub,
            size: 1
          }
        }
      }
    );
    expect(result).toEqual({
      size: 1,
      userId,
    });
  });
});

describe('buildData', () => {
  test('build data from upstreamRequest data', () => {
    const userId = 'user-id';
    const event = {
      requestContext: {
        authorizer: {
          claims:{
            sub: userId
          }
        }
      },
      body: JSON.stringify({
        toPassAlong: 'do not modify me'
      }),
    } as unknown;
    const result = buildData(
      event as APIGatewayEvent,
      {
        upstreamRequest: {
          data: {
            userId: (event: APIGatewayEvent) => event?.requestContext?.authorizer?.claims?.sub,
            static: 'data',
          }
        }
      }
    );
    expect(result).toEqual({
      static: 'data',
      toPassAlong: 'do not modify me',
      userId,
    });
  });

  test('build data from upstreamRequest data when data is array', () => {
    const userId = 'user-id';
    const event = {
      requestContext: {
        authorizer: {
          claims:{
            sub: userId
          }
        }
      },
      body: JSON.stringify(['do not modify me']),
    } as unknown;
    const result = buildData(
      event as APIGatewayEvent,
      {
        upstreamRequest: {
          data: [
            (event: APIGatewayEvent) => event?.requestContext?.authorizer?.claims?.sub,
            'additional data',
          ]
        }
      }
    );
    expect(result).toEqual([
      'do not modify me',
      'user-id',
      'additional data',
    ]);
  });

  test('build data when data is array and no upstreamRequest data is defined', () => {
    const userId = 'user-id';
    const event = {
      requestContext: {
        authorizer: {
          claims:{
            sub: userId
          }
        }
      },
      body: JSON.stringify(['do not modify me']),
    } as unknown;
    const result = buildData(
      event as APIGatewayEvent,
      {
        upstreamRequest: {
        }
      }
    );
    expect(result).toEqual([
      'do not modify me',
    ]);
  });
});

describe('forward', () => {
  const url = '/url-to-forward';

  test('resolve when status code is request is successful', async () => {
    const statusCode = 400;
    const data = { message: 'Bad Request' };
    const config = {
      url,
      method: 'POST',
      data: { name: 'value' },
    } as AxiosRequestConfig;
    mockHttpClient.onAny(url).reply(statusCode, data);
    return forward(config)
      .then(res => {
        expect(res.statusCode).toEqual(statusCode);
        expect(res.data).toEqual(data);
      });
  });

  test('reject on network errors', () => {
    mockHttpClient.onAny(url).networkError();
    return forward({ url, method: 'GET' })
      .then(
        () => Promise.reject('should not be here'),
        error => {
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toEqual('Network Error');
        });
  });
});

describe('handleProxiedRequest', () => {

  test('forward request upstream and return status code and data', async () => {
    const event = {
      httpMethod: 'PUT',
      body: JSON.stringify({ key: 'value' }),
    } as unknown;
    const upstreamUrl = '/upstream';
    const statusCode = 201;
    const data = { created: true };
    mockHttpClient.onAny(upstreamUrl).reply(statusCode, data);
    const routeRule = {
      upstreamRequest: {
        url: upstreamUrl,
        method: 'POST' as Method,
      }
    };
    const config = { headers: { 'x-custom': 'value' } };
    return handleProxiedRequest(event as APIGatewayEvent, routeRule, config)
      .then(res => {
        expect(res.statusCode).toEqual(statusCode);
        expect(JSON.parse(res.body)).toEqual(data);
        expect(mockHttpClient.history.post).toHaveLength(1);
        const mockedRequest = mockHttpClient.history.post[0];
        expect(mockedRequest.method).toEqual('post');
        expect(mockedRequest.headers).toEqual(expect.objectContaining(config.headers));
      });
  });

  test('forward request with event httpMethod when upstream method is not set', async () => {
    const event = {
      httpMethod: 'PUT',
    } as unknown;
    const upstreamUrl = '/upstream';
    const statusCode = 204;
    mockHttpClient.onAny(upstreamUrl).reply(statusCode);
    const routeRule = {
      upstreamRequest: {
        url: upstreamUrl,
      }
    };
    return handleProxiedRequest(event as APIGatewayEvent, routeRule)
      .then(res => {
        expect(res.statusCode).toEqual(statusCode);
        expect(mockHttpClient.history.put).toHaveLength(1);
        const mockedRequest = mockHttpClient.history.put[0];
        expect(mockedRequest.method).toEqual('put');
      });
  });

  test('transform response when defined on the route rule', async () => {
    const event = {
      httpMethod: 'PUT',
    } as unknown;
    const upstreamUrl = '/upstream';
    const transformedStatusCode = 403;
    mockHttpClient.onAny(upstreamUrl).reply(401);
    const routeRule = {
      upstreamRequest: {
        url: upstreamUrl,
      },
      responseTransformer: (response: HttpResponse) => ({
        ...response,
        statusCode: transformedStatusCode
      }),
    };
    return handleProxiedRequest(event as APIGatewayEvent, routeRule)
      .then(res => {
        expect(res.statusCode).toEqual(transformedStatusCode);
        expect(mockHttpClient.history.put).toHaveLength(1);
        const mockedRequest = mockHttpClient.history.put[0];
        expect(mockedRequest.method).toEqual('put');
      });
  });

  test('return 500 when route rule is not valid', async () => {
    const event = {} as unknown;
    const routeRule = {
      upstreamRequest: {},
    };
    return handleProxiedRequest(event as APIGatewayEvent, routeRule)
      .then(res => {
        expect(res.statusCode).toEqual(500);
      });
  });

  test('return 500 when error occurs while forwarding request', async () => {
    const upstreamUrl = '/upstream';
    const event = {};
    const routeRule = {
      upstreamRequest: {
        url: upstreamUrl
      }
    };
    mockHttpClient.onAny(upstreamUrl).networkError();
    return handleProxiedRequest(event as APIGatewayEvent, routeRule)
      .then(res => {
        expect(res.statusCode).toEqual(500);
      });
  });
});

describe('proxy', () => {
  test('return status code and data from upstream request', async () => {
    const incomingPath = '/incoming';
    const upstreamUrl = '/upstream';
    const event = {
      resource: incomingPath,
      httpMethod: 'GET',
    };
    const routeRules = [
      {
        incomingRequest: {
          path: incomingPath,
        },
        upstreamRequest: {
          url: upstreamUrl,
        },
      },
    ];
    const config = {};
    const statusCode = 200;
    const data = { key: 'value' };
    mockHttpClient.onAny().reply(statusCode, data);
    const response = await proxy(routeRules, config)(event as APIGatewayEvent);
    expect(response.statusCode).toEqual(statusCode);
    expect(JSON.parse(response.body)).toEqual(data);
  });

  test('return 405 when rule does not match incoming request', async () => {
    const routeRules: ProxiedRouteRule[] = [
      {
        incomingRequest: {
          path: '/not-matching-route',
          method: 'GET',
        },
        upstreamRequest: {},
      }
    ];
    const config = {};
    const event = {
      httpMethod: 'GET',
      resource: '/route',
    };
    const response = await proxy(routeRules, config)(event as APIGatewayEvent);
    expect(response.statusCode).toEqual(405);
    expect(JSON.parse(response.body)).toEqual({ message: 'Incoming request is not proxied' });
  });
});
