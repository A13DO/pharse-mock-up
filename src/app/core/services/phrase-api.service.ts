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

export interface Job {
  uid: string;
  innerId: string;
  status:
    | 'NEW'
    | 'EMAILED'
    | 'ACCEPTED'
    | 'DECLINED'
    | 'COMPLETED'
    | 'CANCELLED';
  providers?: Array<{
    type: string;
    id: string;
    uid: string;
  }>;
  targetLang: string;
  workflowStep?: {
    name: string;
    id: string;
    order: number;
    workflowLevel: number;
  };
  filename: string;
  originalFile?: string;
  translatedFile?: string;
  originalFileDirectory?: string;
  dateDue?: string;
  dateCreated: string;
  importStatus?: {
    status: 'RUNNING' | 'COMPLETED' | 'FAILED';
    errorMessage?: string;
  };
  continuous?: boolean;
  sourceFileUid?: string;
  split?: boolean;
  serverTaskId?: string;
  owner?: {
    firstName: string;
    lastName: string;
    userName: string;
    email: string;
    role: string;
    id: string;
    uid: string;
  };
  remoteFile?: {
    humanReadableFolder: string;
    humanReadableFileName: string;
    encodedFolder: string;
    encodedFileName: string;
  };
  imported?: boolean;
}

export interface JobsResponse {
  totalElements: number;
  totalPages: number;
  pageSize: number;
  pageNumber: number;
  numberOfElements: number;
  content: Job[];
  sort?: {
    orders: Array<{
      direction: 'ASC' | 'DESC';
      property: string;
    }>;
  };
}

export interface ProjectTemplate {
  templateName: string;
  sourceLang: string;
  targetLangs: string[];
  id: string;
  uid: string;
  note?: string;
  owner?: {
    firstName: string;
    lastName: string;
    userName: string;
    email: string;
    role: string;
    id: string;
    uid: string;
  };
  createdBy?: {
    firstName: string;
    lastName: string;
    userName: string;
    email: string;
    role: string;
    id: string;
    uid: string;
  };
  dateCreated?: string;
  domain?: { id: string; uid: string; name: string };
  subDomain?: { id: string; uid: string; name: string };
  costCenter?: { id: string; uid: string; name: string };
  businessUnit?: { id: string; uid: string; name: string };
  client?: { id: string; uid: string; name: string };
}

export interface ProjectTemplatesResponse {
  totalElements: number;
  totalPages: number;
  pageSize: number;
  pageNumber: number;
  numberOfElements: number;
  content: ProjectTemplate[];
  sort?: {
    orders: Array<{
      direction: 'ASC' | 'DESC';
      property: string;
    }>;
  };
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
      .get<ProjectsResponse>('https://phrase.runasp.net/api/Phrase/projects')
      .pipe(catchError(this.handleError));
  }

  getProject(projectUid: string): Observable<ProjectDetail> {
    return this.http
      .get<ProjectDetail>(
        `https://phrase.runasp.net/api/Phrase/projects/${projectUid}`,
      )
      .pipe(catchError(this.handleError));
  }

  getJobs(projectUid: string): Observable<JobsResponse> {
    return this.http
      .get<JobsResponse>(
        `https://phrase.runasp.net/api/Jobs/projects/${projectUid}/jobs`,
      )
      .pipe(catchError(this.handleError));
  }

  getProjectTemplates(): Observable<ProjectTemplatesResponse> {
    return this.http
      .get<ProjectTemplatesResponse>(`${this.baseUrl}/v1/projectTemplates`, {
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

  /**
   * Download original source file from Phrase TMS
   * @param projectUid - Project unique identifier
   * @param jobUid - Job unique identifier
   * @returns Observable that completes when download starts
   */
  downloadOriginalFile(projectUid: string, jobUid: string): Observable<void> {
    const token = this.authService.getToken();
    if (!token) {
      return throwError(
        () => new Error('Authentication token is required for download'),
      );
    }

    const headers = new HttpHeaders({
      Authorization: token,
    });

    return new Observable((observer) => {
      this.http
        .get(`/web/api2/v1/projects/${projectUid}/jobs/${jobUid}/preview`, {
          headers,
          responseType: 'blob',
          observe: 'response',
        })
        .pipe(catchError(this.handleError))
        .subscribe({
          next: (response) => {
            // Extract filename from Content-Disposition header
            const contentDisposition = response.headers.get(
              'Content-Disposition',
            );
            let filename = 'job-file';

            if (contentDisposition) {
              // Try RFC 5987 encoding first (filename*=UTF-8''filename.ext)
              const utf8Match = contentDisposition.match(
                /filename\*=UTF-8''(.+)/i,
              );
              if (utf8Match) {
                filename = decodeURIComponent(utf8Match[1]);
              } else {
                // Fall back to plain filename="file.txt" or filename=file.txt
                const plainMatch =
                  contentDisposition.match(/filename="?([^"]+)"?/i);
                if (plainMatch) {
                  filename = plainMatch[1];
                }
              }
            }

            // Create blob and trigger download
            const blob = response.body as Blob;
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();

            // Cleanup
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);

            observer.next();
            observer.complete();
          },
          error: (error) => {
            observer.error(error);
          },
        });
    });
  }

  /**
   * Download original source file as Blob (without triggering browser download)
   * @param projectUid - Project unique identifier
   * @param jobUid - Job unique identifier
   * @returns Promise with the file as Blob
   */
  downloadOriginalFileAsBlob(
    projectUid: string,
    jobUid: string,
  ): Promise<Blob> {
    const token = this.authService.getToken();
    if (!token) {
      return Promise.reject(
        new Error('Authentication token is required for download'),
      );
    }

    const headers = new HttpHeaders({
      Authorization: token,
    });

    return new Promise((resolve, reject) => {
      this.http
        .get(`/web/api2/v1/projects/${projectUid}/jobs/${jobUid}/preview`, {
          headers,
          responseType: 'blob',
          observe: 'response',
        })
        .pipe(catchError(this.handleError))
        .subscribe({
          next: (response) => {
            const blob = response.body as Blob;
            resolve(blob);
          },
          error: (error) => {
            reject(error);
          },
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
