import {
    PaperbackInterceptor,
    type Request,
    type Response,
} from "@paperback/types";

export class MainInterceptor extends PaperbackInterceptor {
    override async interceptRequest(request: Request): Promise<Request> {
        const isApi = request.url.includes("api.kagane.org");
        
        // Préférences utilisateur pour forcer l'affichage complet
        const userPreferences = JSON.stringify({
            viewMode: "grid",
            pageSize: 200,
            chapterSort: "desc", 
            hideReadChapters: false,
            thumbnailSize: "normal",
        });
        const encodedPreferences = encodeURIComponent(userPreferences);

        // On définit les headers de base.
        // IMPORTANT : On NE définit PAS 'Content-Type' ici pour ne pas écraser celui du POST.
        request.headers = {
            ...request.headers,
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0",
            referer: "https://kagane.org/",
            origin: "https://kagane.org",
            cookie: `kagane_content_rating=%5B%22safe%22%2C%22suggestive%22%5D; kagane_content_rating_onboarding=true; chaptersPerPage=200; kagane-user-preferences=${encodedPreferences}`,
        };

        return request;
    }

    override async interceptResponse(
        request: Request,
        response: Response,
        data: ArrayBuffer,
    ): Promise<ArrayBuffer> {
        return data;
    }
}