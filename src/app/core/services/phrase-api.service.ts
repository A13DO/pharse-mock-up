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

export interface ProjectsResponse {
  content: Project[];
  totalElements: number;
  totalPages: number;
}

@Injectable({
  providedIn: 'root',
})
export class PhraseApiService {
  private http = inject(HttpClient);
  private authService = inject(AuthService);
  private baseUrl = environment.phraseApiBaseUrl;

  private getHeaders(): HttpHeaders {
    const token = this.authService.getToken();
    return new HttpHeaders({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    });
  }

  getProjects(): Observable<ProjectsResponse> {
    return this.http
      .get<ProjectsResponse>(`https://cloud.memsource.com/web/api2/v1/projects`, {
        headers: this.getHeaders(),
      })
      .pipe(catchError(this.handleError));
  }

  createProject(payload: CreateProjectDto): Observable<Project> {
    return this.http
      .post<Project>(`${this.baseUrl}/v3/projects`, payload, {
        headers: this.getHeaders(),
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
