import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly TOKEN_KEY = 'phrase_api_token';
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
