import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  FormBuilder,
  FormGroup,
  FormControl,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import {
  PhraseApiService,
  CreateProjectDto,
  Language,
  ProjectTemplate,
} from '../../../core/services/phrase-api.service';
import { HeaderComponent } from '../../../layout/header/header.component';
import { Select } from 'primeng/select';
import { MultiSelect } from 'primeng/multiselect';

@Component({
  selector: 'app-project-create',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    HeaderComponent,
    Select,
    MultiSelect,
  ],
  templateUrl: './project-create.component.html',
  styleUrl: './project-create.component.scss',
})
export class ProjectCreateComponent implements OnInit {
  private fb = inject(FormBuilder);
  private phraseApi = inject(PhraseApiService);
  private router = inject(Router);

  projectForm!: FormGroup;
  submitting = false;
  error: string | null = null;

  languages: Language[] = [];
  loadingLanguages = false;
  languageError: string | null = null;

  templates: ProjectTemplate[] = [];
  loadingTemplates = false;
  templateError: string | null = null;

  ngOnInit(): void {
    this.projectForm = this.fb.group({
      template: [null],
      name: ['', Validators.required],
      sourceLang: [null, Validators.required],
      targetLangs: [[], Validators.required],
      purchaseOrder: [''],
      dateDue: [''],
      note: [''],
      fileHandover: [false],
    });

    this.loadLanguages();
    this.loadTemplates();
  }

  loadLanguages(): void {
    this.loadingLanguages = true;
    this.languageError = null;

    this.phraseApi.getLanguages().subscribe({
      next: (response) => {
        this.languages = response.languages;
        this.loadingLanguages = false;
      },
      error: (err) => {
        this.languageError =
          'Failed to load languages. Using manual input as fallback.';
        this.loadingLanguages = false;
        console.error('Failed to load languages:', err);
      },
    });
  }

  loadTemplates(): void {
    this.loadingTemplates = true;
    this.templateError = null;

    this.phraseApi.getProjectTemplates().subscribe({
      next: (response) => {
        this.templates = response.content;
        this.loadingTemplates = false;
      },
      error: (err) => {
        this.templateError = 'Failed to load templates.';
        this.loadingTemplates = false;
        console.error('Failed to load templates:', err);
      },
    });
  }

  onTemplateSelect(event: any): void {
    const template = event?.value || event;
    if (!template) {
      return;
    }

    // Find the source language object
    const sourceLang = this.languages.find(
      (lang) => lang.code === template.sourceLang,
    );

    // Find the target language objects
    const targetLangs = this.languages.filter((lang) =>
      template.targetLangs.includes(lang.code),
    );

    // Populate the form with template data
    this.projectForm.patchValue({
      name: template.templateName,
      sourceLang: sourceLang || null,
      targetLangs: targetLangs,
      note: template.note || '',
    });
  }

  getControl(name: string): FormControl {
    return this.projectForm.get(name) as FormControl;
  }

  onSubmit(): void {
    if (this.projectForm.invalid) {
      this.projectForm.markAllAsTouched();
      return;
    }

    this.submitting = true;
    this.error = null;

    const formValue = this.projectForm.value;

    // Extract language codes from selected Language objects
    const sourceLangCode = formValue.sourceLang?.code || formValue.sourceLang;
    const targetLangCodes = formValue.targetLangs.map(
      (lang: Language | string) =>
        typeof lang === 'string' ? lang : lang.code,
    );

    const payload: CreateProjectDto = {
      name: formValue.name,
      sourceLang: sourceLangCode,
      targetLangs: targetLangCodes,
      purchaseOrder: formValue.purchaseOrder || undefined,
      note: formValue.note || undefined,
      fileHandover: formValue.fileHandover,
    };

    // Format date to ISO string if provided
    if (formValue.dateDue) {
      payload.dateDue = new Date(formValue.dateDue).toISOString();
    }

    this.phraseApi.createProject(payload).subscribe({
      next: (project) => {
        console.log('Project created successfully:', project);
        this.router.navigate(['/projects']);
      },
      error: (err) => {
        this.error = err.message;
        this.submitting = false;
        console.error('Failed to create project:', err);
      },
    });
  }

  cancel(): void {
    this.router.navigate(['/projects']);
  }
}
