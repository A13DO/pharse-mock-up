import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, catchError, throwError } from 'rxjs';

export interface Language {
  code: string;
  name: string;
  rfc: string;
  android: string;
  androidBcp: string;
}

export interface LanguagesResponse {
  languages: Language[];
}

@Injectable({
  providedIn: 'root',
})
export class MemsourceLanguageService {
  private http = inject(HttpClient);
  private baseUrl = '/web/api2/v1';

  private getHeaders(): HttpHeaders {
    return new HttpHeaders({
      'Content-Type': 'application/json',
    });
  }

  /**
   * Get all available languages from Memsource
   * @returns Observable of languages response
   */
  getLanguages(): Observable<LanguagesResponse> {
    return this.http
      .get<LanguagesResponse>(`${this.baseUrl}/languages`, {
        headers: this.getHeaders(),
      })
      .pipe(catchError(this.handleError));
  }

  /**
   * Get a specific language by code
   * @param code - Language code (e.g., 'en', 'ar')
   * @returns Language object if found
   */
  getLanguageByCode(code: string): Observable<Language | undefined> {
    return new Observable((observer) => {
      this.getLanguages().subscribe({
        next: (response) => {
          const language = response.languages.find(
            (lang) => lang.code.toLowerCase() === code.toLowerCase(),
          );
          observer.next(language);
          observer.complete();
        },
        error: (error) => observer.error(error),
      });
    });
  }

  private handleError(error: any): Observable<never> {
    console.error('Memsource API Error:', error);
    return throwError(
      () => new Error('Failed to fetch languages from Memsource'),
    );
  }
}
