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
  private readonly USER_KEY = 'phrase_user';
  private readonly DEFAULT_TOKEN =
    'xP9wYiDiH1TPo1d0aRmQDivvrzMJf6h6DeKYwMWkKMjV0rKB0x4ek1SsiGv6QovXf';

  constructor() {
    // Check for old token and log it
    const existingToken = localStorage.getItem(this.TOKEN_KEY);
    console.log(
      '🔐 Constructor - Current token in localStorage:',
      existingToken,
    );
    console.log('🔐 Constructor - Expected token:', this.DEFAULT_TOKEN);
    console.log(
      '🔐 Constructor - Tokens match:',
      existingToken === this.DEFAULT_TOKEN,
    );

    // Initialize with default token if not already set
    if (!existingToken) {
      console.log('🔐 Constructor - No token found, setting default');
      this.setToken(this.DEFAULT_TOKEN);
    } else if (existingToken !== this.DEFAULT_TOKEN) {
      console.warn(
        '🔐 Constructor - Token mismatch! Updating to correct token',
      );
      this.setToken(this.DEFAULT_TOKEN);
    }
  }

  getToken(): string | null {
    const token = localStorage.getItem(this.TOKEN_KEY);
    // Trim whitespace that might have been accidentally added
    return token ? token.trim() : null;
  }

  setToken(token: string): void {
    // Trim whitespace before storing
    const cleanToken = token.trim();
    console.log('🔐 setToken() - Storing token:', cleanToken);
    localStorage.setItem(this.TOKEN_KEY, cleanToken);
  }

  clearToken(): void {
    localStorage.removeItem(this.TOKEN_KEY);
  }

  hasToken(): boolean {
    return !!this.getToken();
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
          console.log('🔐 Token received, expires:', response.expires);
          this.setToken(response.token);
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

  // Debug utility - call from browser console if needed
  forceResetToken(): void {
    console.log('🔐 Force resetting token to default');
    localStorage.removeItem(this.TOKEN_KEY);
    this.setToken(this.DEFAULT_TOKEN);
    console.log('🔐 Token reset complete. Token is now:', this.getToken());
  }

  // Debug utility - get full token (not masked)
  getFullToken(): string {
    return this.getToken() || '';
  }
}
