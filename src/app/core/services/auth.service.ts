import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';

export interface LoginRequest {
  userName: string;
  password: string;
}

export interface User {
  firstName: string;
  lastName: string;
  userName: string;
  email: string;
  role: string;
  id: string;
  uid: string;
}

export interface LoginResponse {
  user: User;
  token: string;
  expires: string;
  lastInvalidateAllSessionsPerformed: string;
}

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly TOKEN_KEY = 'phrase_api_token';
  private readonly TOKEN_EXPIRES_KEY = 'phrase_api_token_expires';
  private readonly USER_KEY = 'phrase_user';

  /**
   * Check if the stored token is expired
   */
  isTokenExpired(): boolean {
    const expiresStr = localStorage.getItem(this.TOKEN_EXPIRES_KEY);
    if (!expiresStr) {
      // No expiration stored - assume expired for safety
      return true;
    }

    try {
      const expiresDate = new Date(expiresStr);
      const now = new Date();
      return now >= expiresDate;
    } catch (e) {
      console.error('🔐 Error parsing token expiration date:', e);
      return true; // Assume expired on error
    }
  }

  /**
   * Get remaining time until token expires in milliseconds
   */
  getTokenTimeRemaining(): number {
    const expiresStr = localStorage.getItem(this.TOKEN_EXPIRES_KEY);
    if (!expiresStr) return 0;

    try {
      const expiresDate = new Date(expiresStr);
      const now = new Date();
      const remaining = expiresDate.getTime() - now.getTime();
      return Math.max(0, remaining);
    } catch (e) {
      return 0;
    }
  }

  /**
   * Get token expiration date
   */
  getTokenExpirationDate(): Date | null {
    const expiresStr = localStorage.getItem(this.TOKEN_EXPIRES_KEY);
    if (!expiresStr) return null;

    try {
      return new Date(expiresStr);
    } catch (e) {
      console.error('🔐 Error parsing token expiration date:', e);
      return null;
    }
  }

  getToken(): string | null {
    const token = localStorage.getItem(this.TOKEN_KEY);
    if (!token) return null;

    // Check if token is expired
    if (this.isTokenExpired()) {
      console.warn('🔐 Token has expired, clearing session');
      this.logout();
      return null;
    }

    // Trim whitespace that might have been accidentally added
    return token.trim();
  }

  setToken(token: string, expires?: string): void {
    // Trim whitespace before storing
    const cleanToken = token.trim();
    console.log('🔐 setToken() - Storing token:', cleanToken);
    localStorage.setItem(this.TOKEN_KEY, cleanToken);

    // Store expiration if provided
    if (expires) {
      console.log('🔐 Token expires:', expires);
      localStorage.setItem(this.TOKEN_EXPIRES_KEY, expires);

      // Log time until expiration
      const timeRemaining = this.getTokenTimeRemaining();
      const hours = Math.floor(timeRemaining / (1000 * 60 * 60));
      const minutes = Math.floor(
        (timeRemaining % (1000 * 60 * 60)) / (1000 * 60),
      );
      console.log(`🔐 Token valid for ${hours}h ${minutes}m`);
    }
  }

  clearToken(): void {
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.TOKEN_EXPIRES_KEY);
  }

  hasToken(): boolean {
    const token = this.getToken(); // This will check expiration
    return !!token;
  }

  // Login method
  login(credentials: LoginRequest): Observable<LoginResponse> {
    console.log('🔐 Attempting login for user:', credentials.userName);
    return this.http
      .post<LoginResponse>(
        'https://phrase.runasp.net/api/Auth/login',
        credentials,
      )
      .pipe(
        tap((response) => {
          console.log('🔐 Login successful! User:', response.user.userName);
          this.setToken(response.token, response.expires);
          this.setUser(response.user);
        }),
      );
  }

  // Logout method
  logout(): void {
    console.log('🔐 Logging out user');
    this.clearToken();
    this.clearUser();
  }

  // User management methods
  getUser(): User | null {
    const userJson = localStorage.getItem(this.USER_KEY);
    if (!userJson) return null;
    try {
      return JSON.parse(userJson);
    } catch (e) {
      console.error('🔐 Error parsing user data:', e);
      return null;
    }
  }

  setUser(user: User): void {
    console.log('🔐 Storing user:', user.userName);
    localStorage.setItem(this.USER_KEY, JSON.stringify(user));
  }

  clearUser(): void {
    localStorage.removeItem(this.USER_KEY);
  }

  isLoggedIn(): boolean {
    return this.hasToken() && !!this.getUser();
  }

  getMaskedToken(): string {
    const token = this.getToken();
    if (!token) return '';
    if (token.length <= 8) return '***';
    return token.substring(0, 4) + '***' + token.substring(token.length - 4);
  }

  // Debug utility - get full token (not masked)
  getFullToken(): string {
    return this.getToken() || '';
  }
}
