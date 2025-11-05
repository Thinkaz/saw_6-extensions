import {
    PaperbackInterceptor,
    type Request,
    type Response,
} from "@paperback/types";

export class MainInterceptor extends PaperbackInterceptor {
    override async interceptRequest(request: Request): Promise<Request> {
        request.headers = {
            ...request.headers,
            referer: `https://roliascan.com/`,
            origin: `https://roliascan.com`,
            "user-agent": await Application.getDefaultUserAgent(),
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/avif,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.5",
            "accept-encoding": "gzip, deflate, br",
            "cache-control": "no-cache",
            pragma: "no-cache",
            "upgrade-insecure-requests": "1",
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
