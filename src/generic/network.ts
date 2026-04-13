import {
    CloudflareError,
    PaperbackInterceptor,
    type Request,
    type Response,
} from "@paperback/types";

export class AnimaceInterceptor extends PaperbackInterceptor {
    private domain: string;

    constructor(id: string, domain: string) {
        super(id);
        this.domain = domain;
    }

    override async interceptRequest(request: Request): Promise<Request> {
        request.headers = {
            referer: `${this.domain}/`,
            origin: this.domain,
            "user-agent": await Application.getDefaultUserAgent(),
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/avif,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.5",
            "accept-encoding": "gzip, deflate, br",
            "cache-control": "no-cache",
            pragma: "no-cache",
            "upgrade-insecure-requests": "1",
            ...request.headers,
        };

        return request;
    }

    override async interceptResponse(
        request: Request,
        response: Response,
        data: ArrayBuffer,
    ): Promise<ArrayBuffer> {
        void request;
        void response;

        return data;
    }
}

export async function checkStatus(
    status: number,
    request: Request,
): Promise<void> {
    if (status >= 200 && status < 300) {
        return;
    }

    if (status === 503 || status === 403) {
        throw new CloudflareError(
            request,
            `Cloudflare bypass required (Status: ${status})`,
        );
    }
    throw new Error(`HTTP Error: ${status} for url: ${request.url}`);
}

export async function fetchRequest(request: Request): Promise<string> {
    const [response, data] = await Application.scheduleRequest(request);
    await checkStatus(response.status, request);
    return Application.arrayBufferToUTF8String(data);
}
