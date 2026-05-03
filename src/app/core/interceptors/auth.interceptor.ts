import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { HttpInterceptorFn } from '@angular/common/http';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const token = authService.getToken();

  console.log('🔑 Interceptor - Request URL:', req.url);

  // Check if token is expired
  if (authService.hasToken() && authService.isTokenExpired()) {
    console.warn('🔑 Interceptor - Token has expired');
    const expirationDate = authService.getTokenExpirationDate();
    if (expirationDate) {
      console.warn(
        '🔑 Interceptor - Token expired at:',
        expirationDate.toISOString(),
      );
    }
  } else if (token) {
    const timeRemaining = authService.getTokenTimeRemaining();
    const minutes = Math.floor(timeRemaining / (1000 * 60));
    console.log(`🔑 Interceptor - Token valid for ${minutes} minutes`);
  }

  console.log('🔑 Interceptor - Token retrieved:', token);
  console.log('🔑 Interceptor - Token length:', token?.length);

  // Add ApiToken to Phrase API requests
  if (
    token &&
    (req.url.includes('cloud.memsource.com') ||
      req.url.includes('phrase.runasp.net'))
  ) {
    const authHeader = `ApiToken ${token}`;
    console.log('🔑 Interceptor - Setting Authorization header:', authHeader);
    console.log('🔑 Interceptor - Header length:', authHeader.length);

    const authReq = req.clone({
      setHeaders: {
        Authorization: authHeader,
      },
    });

    console.log('🔑 Interceptor - Cloned request headers:', {
      Authorization: authReq.headers.get('Authorization'),
      'Content-Type': authReq.headers.get('Content-Type'),
    });

    return next(authReq);
  }

  console.log(
    '🔑 Interceptor - Not adding auth header (no token or wrong URL)',
  );
  return next(req);
};
