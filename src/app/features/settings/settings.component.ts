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
  showOpenAIKey = false;
  showAnthropicKey = false;
  showGoogleKey = false;
  saveSuccess = false;
  aiSaveSuccess = false;

  ngOnInit(): void {
    this.settingsForm = this.fb.group({
      apiToken: ['', Validators.required],
      openaiApiKey: [''],
      anthropicApiKey: [''],
      googleApiKey: [''],
    });

    // Load existing token (masked)
    if (this.authService.hasToken()) {
      this.settingsForm.patchValue({
        apiToken: this.authService.getMaskedToken(),
      });
    }

    // Load AI API keys
    this.loadAIKeys();
  }

  loadAIKeys(): void {
    const openaiKey = localStorage.getItem('openai_api_key');
    const anthropicKey = localStorage.getItem('anthropic_api_key');
    const googleKey = localStorage.getItem('google_api_key');

    this.settingsForm.patchValue({
      openaiApiKey: openaiKey ? this.maskApiKey(openaiKey) : '',
      anthropicApiKey: anthropicKey ? this.maskApiKey(anthropicKey) : '',
      googleApiKey: googleKey ? this.maskApiKey(googleKey) : '',
    });
  }

  maskApiKey(key: string): string {
    if (key.length <= 8) return key;
    return key.substring(0, 4) + '***' + key.substring(key.length - 4);
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

  toggleAIKeyVisibility(provider: 'openai' | 'anthropic' | 'google'): void {
    const showProperty =
      `show${provider.charAt(0).toUpperCase() + provider.slice(1)}Key` as
        | 'showOpenAIKey'
        | 'showAnthropicKey'
        | 'showGoogleKey';
    const formField = `${provider}ApiKey`;

    this[showProperty] = !this[showProperty];

    if (this[showProperty]) {
      const actualKey = localStorage.getItem(`${provider}_api_key`);
      if (actualKey) {
        this.settingsForm.patchValue({
          [formField]: actualKey,
        });
      }
    } else {
      const actualKey = localStorage.getItem(`${provider}_api_key`);
      if (actualKey) {
        this.settingsForm.patchValue({
          [formField]: this.maskApiKey(actualKey),
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

  saveAIKeys(): void {
    const openaiKey = this.settingsForm.value.openaiApiKey;
    const anthropicKey = this.settingsForm.value.anthropicApiKey;
    const googleKey = this.settingsForm.value.googleApiKey;

    // Save only if not masked
    if (openaiKey && !openaiKey.includes('***')) {
      localStorage.setItem('openai_api_key', openaiKey);
    }
    if (anthropicKey && !anthropicKey.includes('***')) {
      localStorage.setItem('anthropic_api_key', anthropicKey);
    }
    if (googleKey && !googleKey.includes('***')) {
      localStorage.setItem('google_api_key', googleKey);
    }

    this.aiSaveSuccess = true;
    this.showOpenAIKey = false;
    this.showAnthropicKey = false;
    this.showGoogleKey = false;

    // Reload masked keys
    this.loadAIKeys();

    setTimeout(() => {
      this.aiSaveSuccess = false;
    }, 3000);
  }

  clearAIKeys(): void {
    if (confirm('Are you sure you want to clear all AI API keys?')) {
      localStorage.removeItem('openai_api_key');
      localStorage.removeItem('anthropic_api_key');
      localStorage.removeItem('google_api_key');
      this.settingsForm.patchValue({
        openaiApiKey: '',
        anthropicApiKey: '',
        googleApiKey: '',
      });
    }
  }
}
