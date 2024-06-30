import {
    type NextRequest,
    type NextFetchEvent,
    NextResponse
} from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';

export class ApiHandlerError extends Error {
    statusCode: number;

    constructor(
        message: string | Record<string, unknown> | { [key: string]: unknown },
        statusCode: number = 400
    ) {
        super(typeof message === 'string' ? message : JSON.stringify(message));
        this.statusCode = statusCode;
    }
}

type HandlerContext<
    TBody extends z.AnyZodObject,
    TQueryParam extends z.AnyZodObject,
    TSegment extends z.AnyZodObject,
    THeaders extends z.AnyZodObject
> = {
    req: NextRequest;
    nfe: NextFetchEvent;
    body: z.infer<TBody>;
    query: z.infer<TQueryParam>;
    segment: z.infer<TSegment>;
    headers: z.infer<THeaders>;
    errors: z.ZodIssue[];
};

export const apiHandler = <
    TBody extends z.AnyZodObject,
    TQueryParam extends z.AnyZodObject,
    TSegment extends z.AnyZodObject,
    THeaders extends z.AnyZodObject
>(
    setup: {
        schema?: {
            body?: TBody;
            query?: TQueryParam;
            segment?: TSegment;
            headers?: THeaders;
        };
        preHandler?: (context: HandlerContext<TBody, TQueryParam, TSegment, THeaders>) => void | Promise<void>;
        config?: {
            return400ValidationError: boolean;
        };
    },
    handler: (context: HandlerContext<TBody, TQueryParam, TSegment, THeaders>) => void | Response | Promise<void | Response>
) => {
    const defaultConfig = {
        return400ValidationError: true
    };

    const config = {
        ...defaultConfig,
        ...(setup.config || {})
    };

    const validationError = (type: string, data: z.ZodIssue | undefined) =>
        NextResponse.json(
            {
                type,
                status: 'validation_error',
                message: data?.message ?? '',
                path: data?.path ?? []
            },
            {
                status: 400
            }
        );

    const objectFromEntries = (entries: IterableIterator<[string, unknown]> | URLSearchParams) => {
        const obj = {} as Record<string, unknown>;

        for (const [key, val] of entries) {
            obj[key] = val;
        }

        return obj;
    };

    return async (req: NextRequest, nfe: NextFetchEvent & { params: unknown }) => {
        const reqClone = req.clone() as NextRequest;

        const context: HandlerContext<TBody, TQueryParam, TSegment, THeaders> = {
            req: reqClone,
            nfe,
            body: {} as z.infer<TBody>,
            query: {} as z.infer<TQueryParam>,
            segment: {} as z.infer<TSegment>,
            headers: {} as z.infer<THeaders>,
            errors: []
        };

        type ValidationKeys = 'body' | 'segment' | 'query' | 'headers';

        const getData = async (type: ValidationKeys) => {
            let data;

            switch (type) {
                case 'body':
                    try {
                        data = await req.json();
                    } catch (e) {
                        if (config.return400ValidationError) {
                            return NextResponse.json(
                                {
                                    type,
                                    status: 'error',
                                    message: 'Invalid JSON body provided',
                                    path: []
                                },
                                {
                                    status: 400
                                }
                            );
                        } else {
                            data = {};
                            console.log('Invalid JSON body provided');
                        }
                    }
                    break;

                case 'segment':
                    data = nfe.params;
                    break;

                case 'query':
                    data = objectFromEntries(new URL(req.url).searchParams);
                    break;

                case 'headers':
                    data = objectFromEntries(headers().entries());
                    break;

                default:
                    throw new Error('Unknown data type');
            }

            return data;
        };

        const toBeParsedList: ValidationKeys[] | null = setup.schema
            ? (Object.entries(setup.schema)
                .filter(([, val]) => !!val)
                .map(([key]) => key) as ValidationKeys[])
            : [];

        if (!!setup.schema && toBeParsedList.length > 0) {
            for (const el of toBeParsedList) {
                const data = await getData(el);
                const parsed = setup.schema[el]?.safeParse(data);

                if (parsed?.success) {
                    context[el] = parsed.data;
                } else {
                    // push error list if defined
                    if (parsed?.error.errors) {
                        context.errors = [...context.errors, ...parsed?.error.errors];
                    }
                    // return 400 if not disabled in config
                    if (config.return400ValidationError) {
                        return validationError(el, parsed?.error.errors[0]);
                    }
                }
            }
        }

        if (setup.preHandler) {
            try {
                await setup.preHandler(context);
            } catch (e) {
                if (e instanceof ApiHandlerError || e instanceof Error) {
                    try {
                        return NextResponse.json(JSON.parse(e.message), {
                            status: e instanceof ApiHandlerError ? e.statusCode || 400 : 400
                        });
                    } catch {
                        // in case if `JSON.parse` fails
                        return new NextResponse(e.message, {
                            status: e instanceof ApiHandlerError ? e.statusCode || 400 : 400
                        });
                    }
                }

                return NextResponse.json(
                    {
                        status: 'error',
                        statusCode: 400,
                        message: 'Pre-handler failed.'
                    },
                    {
                        status: 400
                    }
                );
            }
        }

        // run handler
        return handler(context);
    };
};