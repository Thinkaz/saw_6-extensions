import {
    PaperbackInterceptor,
    type Request,
    type Response,
} from "@paperback/types";

// Intercepts all the requests and responses and allows you to make changes to them
export class MainInterceptor extends PaperbackInterceptor {
    override async interceptRequest(request: Request): Promise<Request> {
        request.headers = {
            ...request.headers,
            referer: `https://www.natomanga.com/`,
            origin: `https://www.natomanga.com`,
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
