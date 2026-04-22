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
} from '../../../core/services/phrase-api.service';
import { FormFieldComponent } from '../../../shared/components/form-field/form-field.component';
import { HeaderComponent } from '../../../layout/header/header.component';

@Component({
  selector: 'app-project-create',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    FormFieldComponent,
    HeaderComponent,
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

  ngOnInit(): void {
    this.projectForm = this.fb.group({
      name: ['', Validators.required],
      sourceLang: ['', Validators.required],
      targetLangs: ['', Validators.required],
      purchaseOrder: [''],
      dateDue: [''],
      note: [''],
      fileHandover: [false],
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

    // Convert comma-separated target languages to array
    const targetLangsArray = formValue.targetLangs
      .split(',')
      .map((lang: string) => lang.trim())
      .filter((lang: string) => lang.length > 0);

    const payload: CreateProjectDto = {
      name: formValue.name,
      sourceLang: formValue.sourceLang,
      targetLangs: targetLangsArray,
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
