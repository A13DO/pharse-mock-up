import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, throwError } from 'rxjs';

export interface AllowedUser {
  email: string;
}

@Injectable({
  providedIn: 'root',
})
export class AllowedUsersService {
  private http = inject(HttpClient);
  private baseUrl = 'https://phrase.runasp.net/api';

  /**
   * Get all allowed users
   */
  getAllowedUsers(): Observable<AllowedUser[]> {
    return this.http
      .get<AllowedUser[]>(`${this.baseUrl}/AllowedUsers`)
      .pipe(catchError(this.handleError));
  }

  /**
   * Get a specific allowed user by email
   */
  getAllowedUser(email: string): Observable<AllowedUser> {
    return this.http
      .get<AllowedUser>(
        `${this.baseUrl}/AllowedUsers/${encodeURIComponent(email)}`,
      )
      .pipe(catchError(this.handleError));
  }

  /**
   * Add a new allowed user
   */
  addAllowedUser(email: string): Observable<AllowedUser> {
    return this.http
      .post<AllowedUser>(`${this.baseUrl}/AllowedUsers`, { email })
      .pipe(catchError(this.handleError));
  }

  /**
   * Update an allowed user
   */
  updateAllowedUser(email: string, newEmail: string): Observable<AllowedUser> {
    return this.http
      .put<AllowedUser>(
        `${this.baseUrl}/AllowedUsers/${encodeURIComponent(email)}`,
        {
          newEmail: newEmail,
        },
      )
      .pipe(catchError(this.handleError));
  }

  /**
   * Delete an allowed user
   */
  deleteAllowedUser(email: string): Observable<void> {
    return this.http
      .delete<void>(`${this.baseUrl}/AllowedUsers/${encodeURIComponent(email)}`)
      .pipe(catchError(this.handleError));
  }

  private handleError(error: any): Observable<never> {
    console.error('API Error:', error);
    const message =
      error.error?.message || error.message || 'An error occurred';
    return throwError(() => new Error(message));
  }
}
