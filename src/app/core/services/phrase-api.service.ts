import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, catchError, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';

export interface CreateProjectDto {
  name: string;
  sourceLang: string;
  targetLangs: string[];
  purchaseOrder?: string;
  dateDue?: string;
  note?: string;
  fileHandover?: boolean;
}

export interface Project {
  uid: string;
  name: string;
  sourceLang: string;
  status: string;
  dateDue?: string;
  createdBy?: {
    userName: string;
    firstName: string;
    lastName: string;
  };
}

export interface ProjectDetail extends Project {
  internalId: number;
  id: string;
  dateCreated: string;
  domain?: { id: string; uid: string; name: string };
  subDomain?: { id: string; uid: string; name: string };
  owner?: {
    firstName: string;
    lastName: string;
    userName: string;
    email: string;
    role: string;
    id: string;
    uid: string;
  };
  targetLangs: string[];
  references: Array<{
    id: string;
    uid: string;
    filename: string;
    note?: string;
    dateCreated: string;
    createdBy?: {
      firstName: string;
      lastName: string;
      userName: string;
      email: string;
    };
  }>;
  mtSettingsPerLanguageList: Array<{
    targetLang?: string;
    machineTranslateSettings: {
      id: string;
      uid: string;
      name: string;
      type: string;
    };
  }>;
  userRole: string;
}

export interface ProjectsResponse {
  content: Project[];
  totalElements: number;
  totalPages: number;
}

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
export class PhraseApiService {
  private http = inject(HttpClient);
  private authService = inject(AuthService);
  private baseUrl = environment.phraseApiBaseUrl;
  private memsourceBaseUrl = '/api/v1';

  private getHeaders(): HttpHeaders {
    const token = this.authService.getToken();
    return new HttpHeaders({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    });
  }

  getProjects(): Observable<ProjectsResponse> {
    return this.http
      .get<ProjectsResponse>(`${this.baseUrl}/v1/projects`, {
        headers: this.getHeaders(),
        withCredentials: true,
      })
      .pipe(catchError(this.handleError));
  }

  getProject(projectUid: string): Observable<ProjectDetail> {
    return this.http
      .get<ProjectDetail>(`${this.baseUrl}/v1/projects/${projectUid}`, {
        headers: this.getHeaders(),
        withCredentials: true,
      })
      .pipe(catchError(this.handleError));
  }

  createProject(payload: CreateProjectDto): Observable<Project> {
    return this.http
      .post<Project>(`${this.baseUrl}/v3/projects`, payload, {
        headers: this.getHeaders(),
        withCredentials: true,
      })
      .pipe(catchError(this.handleError));
  }

  createJob(
    projectUid: string,
    file: File,
    filename: string,
    memsourceHeader: {
      targetLangs: string[];
    },
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const token = this.authService.getToken();
      const url = `${this.baseUrl}/v1/projects/${projectUid}/jobs`;

      const headers = new HttpHeaders({
        Authorization: `Bearer ${token}`,
        'Content-Disposition': `filename="${filename}"`,
        Memsource: JSON.stringify(memsourceHeader),
        'Content-Type': 'application/octet-stream',
      });

      // Read file as binary
      const reader = new FileReader();
      reader.onload = () => {
        const arrayBuffer = reader.result as ArrayBuffer;

        this.http
          .post(url, arrayBuffer, {
            headers,
            withCredentials: true,
            observe: 'response',
          })
          .pipe(catchError(this.handleError))
          .subscribe({
            next: (response) => resolve(response.body),
            error: (error) => reject(error),
          });
      };

      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  }
  /**
   * Get all available languages from Memsource
   * @returns Observable of languages response
   */
  getLanguages(): Observable<LanguagesResponse> {
    return this.http
      .get<LanguagesResponse>(`${this.memsourceBaseUrl}/languages`, {
        headers: this.getHeaders(),
        withCredentials: true,
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
    let errorMessage = 'An error occurred';

    if (error.error instanceof ErrorEvent) {
      // Client-side error
      errorMessage = `Error: ${error.error.message}`;
    } else {
      // Server-side error
      errorMessage =
        error.error?.errorDescription ||
        error.error?.message ||
        `Error Code: ${error.status}\nMessage: ${error.message}`;
    }

    console.error('API Error:', error);
    return throwError(() => new Error(errorMessage));
  }
}
