import { AnimaceGeneric } from "../generic/main";
import pbconfig from "./pbconfig";

const DOMAIN = "https://roliascan.com";

class RoliascanExtension extends AnimaceGeneric {
    constructor() {
        super({
            domain: DOMAIN,
            name: pbconfig.name,
            contentRating: pbconfig.contentRating,
            language: pbconfig.language,
            basicRateLimiter: {
                numberOfRequests: 4,
                bufferInterval: 1,
            },
        });
    }
}

export const Roliascan = new RoliascanExtension();
