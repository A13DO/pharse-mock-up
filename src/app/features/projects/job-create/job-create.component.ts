import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { PhraseApiService } from '../../../core/services/phrase-api.service';
import { HeaderComponent } from '../../../layout/header/header.component';
import { FileUploadModule } from 'primeng/fileupload';
import { MultiSelectModule } from 'primeng/multiselect';
import { InputTextModule } from 'primeng/inputtext';
import { CardModule } from 'primeng/card';
import { MessageModule } from 'primeng/message';

interface CreateJobForm {
  filename: string;
  targetLangs: string[];
  file: File | null;
}

@Component({
  selector: 'app-job-create',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    HeaderComponent,
    FileUploadModule,
    MultiSelectModule,
    InputTextModule,
    CardModule,
    MessageModule,
  ],
  templateUrl: './job-create.component.html',
  styleUrl: './job-create.component.scss',
})
export class JobCreateComponent implements OnInit {
  private phraseApi = inject(PhraseApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  projectUid: string = '';
  form: CreateJobForm = {
    filename: '',
    targetLangs: [],
    file: null,
  };

  availableLanguages = [
    { label: 'German', value: 'de' },
    { label: 'French', value: 'fr' },
    { label: 'Spanish', value: 'es' },
    { label: 'Italian', value: 'it' },
    { label: 'Czech', value: 'cs_cz' },
    { label: 'Polish', value: 'pl' },
    { label: 'Dutch', value: 'nl' },
    { label: 'Portuguese', value: 'pt' },
    { label: 'Russian', value: 'ru' },
    { label: 'Chinese (Simplified)', value: 'zh_cn' },
    { label: 'Japanese', value: 'ja' },
    { label: 'Arabic', value: 'ar' },
  ];

  loading = false;
  error: string | null = null;
  success: string | null = null;
  response: any = null;

  ngOnInit(): void {
    // Get project UID from route params
    const projectUid = this.route.snapshot.queryParamMap.get('projectUid');
    if (projectUid) {
      this.projectUid = projectUid;
    }
  }

  get memsourceHeaderPreview(): string {
    const headerObj = {
      targetLangs: this.form.targetLangs.length > 0 ? this.form.targetLangs : [],
    };

    return JSON.stringify(headerObj, null, 2);
  }

  onFileSelect(event: any): void {
    const file = event.files[0];
    if (file) {
      this.form.file = file;
      if (!this.form.filename) {
        this.form.filename = file.name;
      }
    }
  }

  onFileRemove(): void {
    this.form.file = null;
  }

  isFormValid(): boolean {
    return !!(
      this.projectUid &&
      this.form.filename &&
      this.form.targetLangs.length > 0 &&
      this.form.file
    );
  }

  async onSubmit(): Promise<void> {
    if (!this.isFormValid()) {
      this.error = 'Please fill in all required fields';
      return;
    }

    this.loading = true;
    this.error = null;
    this.success = null;
    this.response = null;

    try {
      const memsourceHeader = {
        targetLangs: this.form.targetLangs,
      };

      const result = await this.phraseApi.createJob(
        this.projectUid,
        this.form.file!,
        this.form.filename,
        memsourceHeader,
      );

      this.response = result;
      this.success = 'Job created successfully!';
      this.loading = false;
    } catch (err: any) {
      this.error = err.message || 'Failed to create job';
      this.loading = false;
      console.error('Failed to create job:', err);
    }
  }

  reset(): void {
    this.form = {
      filename: '',
      targetLangs: [],
      file: null,
    };
    this.error = null;
    this.success = null;
    this.response = null;
  }

  navigateToProject(): void {
    if (this.projectUid) {
      this.router.navigate(['/projects', this.projectUid]);
    }
  }
}
