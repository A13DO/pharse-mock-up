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

export type JobStatus =
  | 'NEW'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'REJECTED'
  | 'DELIVERED'
  | 'EMAILED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface Job {
  uid: string;
  innerId: string;
  status: JobStatus;
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
      .post<Project>('https://phrase.runasp.net/api/Phrase/projects', payload)
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
      const url = `https://phrase.runasp.net/api/Jobs/projects/${projectUid}/jobs`;

      // Create FormData for multipart/form-data request
      const formData = new FormData();
      formData.append('file', file, filename);
      formData.append(
        'targetLangsJson',
        JSON.stringify(memsourceHeader.targetLangs),
      );

      this.http
        .post(url, formData, {
          observe: 'response',
        })
        .pipe(catchError(this.handleError))
        .subscribe({
          next: (response) => resolve(response.body),
          error: (error) => reject(error),
        });
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

  /**
   * Download bilingual file from completed jobs
   * @param projectUid - Project unique identifier
   * @param jobUids - Array of job unique identifiers
   * @param format - File format (MXLF, DOCX, XLIFF, TMX) - default: MXLF
   * @returns Promise with the file as Blob
   */
  downloadBilingualFile(
    projectUid: string,
    jobUids: string[],
    format: 'MXLF' | 'DOCX' | 'XLIFF' | 'TMX' = 'MXLF',
  ): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const url = `https://phrase.runasp.net/api/Jobs/projects/${projectUid}/jobs/bilingualFile`;

      const payload = {
        jobs: jobUids.map((uid) => ({ uid })),
      };

      const headers = new HttpHeaders({
        accept: '*/*',
        'Content-Type': 'application/json',
      });

      this.http
        .post(url, payload, {
          headers,
          params: { format },
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

  /**
   * Upload translated bilingual file back to Phrase TMS
   * @param jobUid - Job unique identifier
   * @param file - Translated bilingual DOCX file
   * @param saveToTransMemory - Save to translation memory ('None', 'Confirmed', 'All')
   * @param setCompleted - Mark job as completed
   * @returns Promise with the upload response
   */
  uploadBilingualFile(
    jobUid: string,
    file: File,
    saveToTransMemory: 'None' | 'Confirmed' | 'All' = 'Confirmed',
    setCompleted: boolean = true,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = `https://phrase.runasp.net/api/Jobs/bilingual-files`;

      const formData = new FormData();
      formData.append('file', file, file.name);

      this.http
        .post(url, formData, {
          params: {
            jobUid,
            saveToTransMemory,
            setCompleted: setCompleted.toString(),
          },
          observe: 'response',
        })
        .pipe(catchError(this.handleError))
        .subscribe({
          next: (response) => {
            resolve(response.body);
          },
          error: (error) => {
            reject(error);
          },
        });
    });
  }

  /**
   * Update job status for one or more jobs
   * @param projectUid - Project unique identifier
   * @param jobUids - Array of job UIDs to update
   * @param status - New job status
   * @returns Observable with the update response
   */
  updateJobStatus(
    projectUid: string,
    jobUids: string[],
    status: JobStatus,
  ): Observable<any> {
    const url = `https://phrase.runasp.net/api/Jobs/projects/${projectUid}/jobs/batch`;
    const body = {
      status,
      jobs: jobUids.map((uid) => ({ uid })),
    };

    return this.http
      .put(url, body, {
        headers: new HttpHeaders({
          'Content-Type': 'application/json',
        }),
      })
      .pipe(catchError(this.handleError));
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
