import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import {
  AuthService,
  type LoginRequest,
} from '../../../core/services/auth.service';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmButton } from '@spartan-ng/helm/button';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, HlmInput, HlmButton],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss'],
})
export class LoginComponent {
  private readonly authService = inject(AuthService);
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);

  loginForm: FormGroup;
  isLoading = signal(false);
  errorMessage = signal<string | null>(null);
  showPassword = signal(false);

  constructor() {
    this.loginForm = this.fb.group({
      userName: ['', [Validators.required, Validators.minLength(3)]],
      password: ['', [Validators.required, Validators.minLength(6)]],
    });
  }

  togglePasswordVisibility(): void {
    this.showPassword.set(!this.showPassword());
  }

  onSubmit(): void {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }

    this.isLoading.set(true);
    this.errorMessage.set(null);

    const credentials: LoginRequest = this.loginForm.value;

    console.log('🔐 Submitting login form for user:', credentials.userName);

    this.authService.login(credentials).subscribe({
      next: (response) => {
        console.log('✅ Login successful!', response);
        this.isLoading.set(false);
        // Navigate to projects page
        this.router.navigate(['/projects']);
      },
      error: (error) => {
        console.error('❌ Login failed:', error);
        this.isLoading.set(false);

        // Handle different error types
        if (error.status === 401) {
          this.errorMessage.set('Invalid username or password');
        } else if (error.status === 0) {
          this.errorMessage.set('Network error. Please check your connection.');
        } else {
          this.errorMessage.set(
            error.error?.message || 'Login failed. Please try again.',
          );
        }
      },
    });
  }

  get userName() {
    return this.loginForm.get('userName');
  }

  get password() {
    return this.loginForm.get('password');
  }
}
