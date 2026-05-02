import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Login Guard - Prevents logged-in users from accessing login page
 * Redirects to /projects if user is already logged in
 */
export const loginGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isLoggedIn()) {
    console.log(
      '🔐 Login Guard: User already logged in, redirecting to projects',
    );
    return router.createUrlTree(['/projects']);
  }

  console.log(
    '🔐 Login Guard: User not logged in, access granted to login page',
  );
  return true;
};
