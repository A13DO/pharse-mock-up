import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { AuthService } from '../../core/services/auth.service';
import { HeaderComponent } from '../../layout/header/header.component';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, HeaderComponent],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  private fb = inject(FormBuilder);
  private authService = inject(AuthService);

  settingsForm!: FormGroup;
  showToken = false;
  saveSuccess = false;

  ngOnInit(): void {
    this.settingsForm = this.fb.group({
      apiToken: ['', Validators.required],
    });

    // Load existing token (masked)
    if (this.authService.hasToken()) {
      this.settingsForm.patchValue({
        apiToken: this.authService.getMaskedToken(),
      });
    }
  }

  toggleTokenVisibility(): void {
    this.showToken = !this.showToken;

    if (this.showToken) {
      const actualToken = this.authService.getToken();
      if (actualToken) {
        this.settingsForm.patchValue({
          apiToken: actualToken,
        });
      }
    } else {
      if (this.authService.hasToken()) {
        this.settingsForm.patchValue({
          apiToken: this.authService.getMaskedToken(),
        });
      }
    }
  }

  onSubmit(): void {
    if (this.settingsForm.valid) {
      const token = this.settingsForm.value.apiToken;

      // Don't save if it's the masked version
      if (!token.includes('***')) {
        this.authService.setToken(token);
        this.saveSuccess = true;
        this.showToken = false;

        // Show masked token after save
        this.settingsForm.patchValue({
          apiToken: this.authService.getMaskedToken(),
        });

        setTimeout(() => {
          this.saveSuccess = false;
        }, 3000);
      }
    }
  }

  clearToken(): void {
    if (confirm('Are you sure you want to clear the API token?')) {
      this.authService.clearToken();
      this.settingsForm.reset();
      this.showToken = false;
    }
  }
}
