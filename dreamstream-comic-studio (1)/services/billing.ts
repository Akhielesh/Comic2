import { post } from './apiClient';

export interface CheckoutSessionResponse {
    url: string;
}

export const createCheckoutSession = async (userEmail: string, userId: string): Promise<string> => {
    const response = await post<any, CheckoutSessionResponse>('/payments/create-checkout-session', {
        email: userEmail,
        userId: userId
    });
    return response.url;
};
