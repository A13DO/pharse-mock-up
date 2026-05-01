import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly TOKEN_KEY = 'phrase_api_token';
  private readonly DEFAULT_TOKEN = 'xZ0U2u2OqE0nqvliTqRvFR0ucGs7twJbaRHniMxy0ablVPpv8gLd4Dp3kNrvcNWo3';

  constructor() {
    // Initialize with default token if not already set
    if (!this.getToken()) {
      this.setToken(this.DEFAULT_TOKEN);
    }
  }

  getToken(): string | null {
    return localStorage.getItem(this.TOKEN_KEY);
  }

  setToken(token: string): void {
    localStorage.setItem(this.TOKEN_KEY, token);
  }

  clearToken(): void {
    localStorage.removeItem(this.TOKEN_KEY);
  }

  hasToken(): boolean {
    return !!this.getToken();
  }

  getMaskedToken(): string {
    const token = this.getToken();
    if (!token) return '';
    if (token.length <= 8) return '***';
    return token.substring(0, 4) + '***' + token.substring(token.length - 4);
  }
}
