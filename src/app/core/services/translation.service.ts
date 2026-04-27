import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

export interface TranslationRequest {
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  model: string;
  context?: string;
}

export interface TranslationResponse {
  translatedText: string;
  model: string;
  confidence?: number;
}

export interface BatchTranslationRequest {
  segments: Array<{
    id: string;
    sourceText: string;
  }>;
  sourceLang: string;
  targetLang: string;
  model: string;
  context?: string;
}

export interface BatchTranslationResponse {
  translations: Array<{
    id: string;
    translatedText: string;
    confidence?: number;
  }>;
}

export interface DocumentTranslationRequest {
  file: File;
  model: string;
  prompt: string;
  sourceLang?: string;
  targetLang?: string;
}

export interface DocumentTranslationResponse {
  file: Blob;
  filename: string;
  model: string;
}

@Injectable({
  providedIn: 'root',
})
export class TranslationService {
  private http = inject(HttpClient);
  private authService = inject(AuthService);
  private baseUrl = '/api/translation'; // This would be your translation API endpoint

  private getHeaders(): HttpHeaders {
    const token = this.authService.getToken();
    return new HttpHeaders({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    });
  }

  /**
   * Translate a single text segment using AI
   * @param request - Translation request with source text and settings
   * @returns Observable with translated text
   */
  translateText(request: TranslationRequest): Observable<TranslationResponse> {
    return this.http
      .post<TranslationResponse>(`${this.baseUrl}/translate`, request, {
        headers: this.getHeaders(),
        withCredentials: true,
      })
      .pipe(catchError(this.handleError));
  }

  /**
   * Translate multiple segments in a batch
   * @param request - Batch translation request
   * @returns Observable with array of translations
   */
  translateBatch(
    request: BatchTranslationRequest,
  ): Observable<BatchTranslationResponse> {
    return this.http
      .post<BatchTranslationResponse>(
        `${this.baseUrl}/translate-batch`,
        request,
        {
          headers: this.getHeaders(),
          withCredentials: true,
        },
      )
      .pipe(catchError(this.handleError));
  }

  /**
   * Translate an entire document using AI
   * @param file - The document file to translate
   * @param model - AI model ID
   * @param prompt - Translation instructions/prompt
   * @returns Promise with translated document
   */
  async translateDocument(
    file: File,
    model: string,
    prompt: string,
  ): Promise<DocumentTranslationResponse> {
    const token = this.authService.getToken();
    if (!token) {
      throw new Error('Authentication token is required');
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('model', model);
    formData.append('prompt', prompt);

    try {
      // In production, this would call your actual AI translation API
      // For now, we'll simulate the translation with a mock response
      const result = await this.mockDocumentTranslation(file, model, prompt);
      return result;
    } catch (error) {
      console.error('Document translation error:', error);
      throw error;
    }
  }

  /**
   * Mock document translation for development/testing
   * Simulates AI document translation with a delay
   */
  private async mockDocumentTranslation(
    file: File,
    model: string,
    prompt: string,
  ): Promise<DocumentTranslationResponse> {
    return new Promise((resolve) => {
      setTimeout(() => {
        // Create a mock translated file (in production, this would be the actual translated document)
        const mockContent = `Translated by ${model}\n\nOriginal file: ${file.name}\nPrompt: ${prompt}\n\nThis is a mock translation. In production, this would be the actual translated document from the AI model.`;
        const blob = new Blob([mockContent], { type: file.type });

        const originalName = file.name;
        const nameParts = originalName.split('.');
        const extension = nameParts.pop();
        const baseName = nameParts.join('.');
        const translatedName = `${baseName}_translated.${extension}`;

        resolve({
          file: blob,
          filename: translatedName,
          model: model,
        });
      }, 2000); // Simulate API delay
    });
  }

  /**
   * Mock translation for development/testing
   * Simulates AI translation with a delay
   */
  mockTranslate(
    sourceText: string,
    model: string,
    delay: number = 500,
  ): Promise<string> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(`[${model}] Translated: ${sourceText}`);
      }, delay);
    });
  }

  /**
   * Get available AI models for translation
   */
  getAvailableModels(): Observable<
    Array<{
      id: string;
      name: string;
      provider: string;
      supportedLanguages?: string[];
    }>
  > {
    return this.http
      .get<
        Array<{
          id: string;
          name: string;
          provider: string;
          supportedLanguages?: string[];
        }>
      >(`${this.baseUrl}/models`, {
        headers: this.getHeaders(),
        withCredentials: true,
      })
      .pipe(catchError(this.handleError));
  }

  private handleError(error: any): Observable<never> {
    let errorMessage = 'An error occurred during translation';

    if (error.error instanceof ErrorEvent) {
      errorMessage = `Error: ${error.error.message}`;
    } else {
      errorMessage =
        error.error?.message ||
        error.error?.errorDescription ||
        `Error Code: ${error.status}\nMessage: ${error.message}`;
    }

    console.error('Translation Service Error:', error);
    return throwError(() => new Error(errorMessage));
  }
}
