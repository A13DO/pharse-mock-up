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
   * @param sourceLang - Source language (optional)
   * @param targetLang - Target language (optional)
   * @returns Promise with translated document
   */
  async translateDocument(
    file: File,
    model: string,
    prompt: string,
    sourceLang?: string,
    targetLang?: string,
  ): Promise<DocumentTranslationResponse> {
    // Determine which provider to use based on model
    const provider = this.getProviderFromModel(model);

    try {
      switch (provider) {
        case 'openai':
          return await this.translateWithOpenAI(
            file,
            model,
            prompt,
            targetLang,
          );
        case 'anthropic':
          return await this.translateWithAnthropic(
            file,
            model,
            prompt,
            targetLang,
          );
        case 'google':
          return await this.translateWithGoogle(
            file,
            model,
            prompt,
            sourceLang,
            targetLang,
          );
        default:
          throw new Error(`Unsupported AI provider: ${provider}`);
      }
    } catch (error) {
      console.error('Document translation error:', error);
      throw error;
    }
  }

  /**
   * Determine AI provider from model ID
   */
  private getProviderFromModel(
    model: string,
  ): 'openai' | 'anthropic' | 'google' {
    if (model.startsWith('gpt')) return 'openai';
    if (model.startsWith('claude')) return 'anthropic';
    if (model.startsWith('gemini')) return 'google';
    return 'openai'; // default
  }

  /**
   * Get API key from localStorage or environment
   */
  private getApiKey(provider: 'openai' | 'anthropic' | 'google'): string {
    const storageKey = `${provider}_api_key`;
    return localStorage.getItem(storageKey) || '';
  }

  /**
   * Read file as text
   */
  private async readFileAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  /**
   * Read file as base64
   */
  private async readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * Translate document using OpenAI API
   */
  private async translateWithOpenAI(
    file: File,
    model: string,
    prompt: string,
    targetLang?: string,
  ): Promise<DocumentTranslationResponse> {
    console.log('🚀 Starting OpenAI translation...');
    console.log('Model:', model);
    console.log('Target Language:', targetLang);
    console.log('File:', file.name, 'Size:', file.size, 'bytes');

    const apiKey = this.getApiKey('openai');
    if (!apiKey) {
      console.error('❌ No OpenAI API key found in localStorage');
      throw new Error(
        'OpenAI API key not configured. Please add it in Settings.',
      );
    }
    console.log('✅ API key found:', apiKey.substring(0, 10) + '...');

    // Read file content
    console.log('📖 Reading file content...');
    const fileContent = await this.readFileAsText(file);
    console.log(
      '✅ File read successfully. Content length:',
      fileContent.length,
      'characters',
    );

    const messages = [
      {
        role: 'system',
        content:
          'You are a professional translator. Translate documents accurately while preserving formatting and structure.',
      },
      {
        role: 'user',
        content: `${prompt}\n\nDocument content:\n${fileContent}`,
      },
    ];

    const requestBody = {
      model: model,
      messages: messages,
      temperature: 0.3,
      max_tokens: 4000,
    };

    console.log('📤 Sending request to OpenAI API...');
    console.log('Request URL:', 'https://api.openai.com/v1/chat/completions');
    console.log(
      'Request body:',
      JSON.stringify(requestBody).substring(0, 200) + '...',
    );

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    console.log(
      '📥 Response received. Status:',
      response.status,
      response.statusText,
    );

    if (!response.ok) {
      console.error('❌ OpenAI API request failed');
      let errorMessage = response.statusText;
      try {
        const error = await response.json();
        console.error('Error details:', error);
        errorMessage = error.error?.message || response.statusText;
      } catch (e) {
        console.error('Could not parse error response:', e);
      }
      throw new Error(`OpenAI API error: ${errorMessage}`);
    }

    console.log('✅ API request successful. Parsing response...');
    const data = await response.json();
    console.log('Response data:', data);

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      console.error('❌ Unexpected response format:', data);
      throw new Error('Unexpected response format from OpenAI API');
    }

    const translatedText = data.choices[0].message.content;
    console.log(
      '✅ Translation completed. Length:',
      translatedText.length,
      'characters',
    );

    // Create translated file blob
    const blob = new Blob([translatedText], { type: file.type });
    const originalName = file.name;
    const nameParts = originalName.split('.');
    const extension = nameParts.pop();
    const baseName = nameParts.join('.');
    const translatedName = `${baseName}_translated_${targetLang || 'target'}.${extension}`;

    return {
      file: blob,
      filename: translatedName,
      model: model,
    };
  }

  /**
   * Translate document using Anthropic Claude API
   */
  private async translateWithAnthropic(
    file: File,
    model: string,
    prompt: string,
    targetLang?: string,
  ): Promise<DocumentTranslationResponse> {
    const apiKey = this.getApiKey('anthropic');
    if (!apiKey) {
      throw new Error(
        'Anthropic API key not configured. Please add it in Settings.',
      );
    }

    // Read file content
    const fileContent = await this.readFileAsText(file);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: `${prompt}\n\nDocument content:\n${fileContent}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(
        `Anthropic API error: ${error.error?.message || response.statusText}`,
      );
    }

    const data = await response.json();
    const translatedText = data.content[0].text;

    // Create translated file blob
    const blob = new Blob([translatedText], { type: file.type });
    const originalName = file.name;
    const nameParts = originalName.split('.');
    const extension = nameParts.pop();
    const baseName = nameParts.join('.');
    const translatedName = `${baseName}_translated_${targetLang || 'target'}.${extension}`;

    return {
      file: blob,
      filename: translatedName,
      model: model,
    };
  }

  /**
   * Translate document using Google Cloud Translation API
   */
  private async translateWithGoogle(
    file: File,
    model: string,
    prompt: string,
    sourceLang?: string,
    targetLang?: string,
  ): Promise<DocumentTranslationResponse> {
    const apiKey = this.getApiKey('google');
    if (!apiKey) {
      throw new Error(
        'Google Cloud API key not configured. Please add it in Settings.',
      );
    }

    // Read file content
    const fileContent = await this.readFileAsText(file);

    const response = await fetch(
      `https://translation.googleapis.com/v3/projects/YOUR_PROJECT_ID/locations/global:translateText?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [fileContent],
          sourceLanguageCode: sourceLang || 'en',
          targetLanguageCode: targetLang || 'es',
          mimeType: 'text/plain',
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(
        `Google Cloud API error: ${error.error?.message || response.statusText}`,
      );
    }

    const data = await response.json();
    const translatedText = data.translations[0].translatedText;

    // Create translated file blob
    const blob = new Blob([translatedText], { type: file.type });
    const originalName = file.name;
    const nameParts = originalName.split('.');
    const extension = nameParts.pop();
    const baseName = nameParts.join('.');
    const translatedName = `${baseName}_translated_${targetLang || 'target'}.${extension}`;

    return {
      file: blob,
      filename: translatedName,
      model: model,
    };
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
