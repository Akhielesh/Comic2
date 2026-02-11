import rateLimit from 'express-rate-limit';
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS } from '../config.js';

export const limiter = rateLimit({
	windowMs: RATE_LIMIT_WINDOW_MS, // 15 minutes
	limit: RATE_LIMIT_MAX_REQUESTS, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
	standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
	legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: {
        error: {
            message: 'Too many requests, please try again later.'
        }
    }
});
