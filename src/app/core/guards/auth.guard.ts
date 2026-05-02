import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Auth Guard - Protects routes that require authentication
 * Redirects to /login if user is not logged in
 */
export const authGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isLoggedIn()) {
    console.log('🔐 Auth Guard: User is logged in, access granted');
    return true;
  }

  console.log('🔐 Auth Guard: User not logged in, redirecting to login');
  console.log('🔐 Attempted URL:', state.url);

  // Redirect to login page
  return router.createUrlTree(['/login']);
};
