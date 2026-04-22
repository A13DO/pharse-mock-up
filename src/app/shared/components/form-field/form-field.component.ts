import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormControl } from '@angular/forms';

@Component({
  selector: 'app-form-field',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './form-field.component.html',
  styleUrl: './form-field.component.scss',
})
export class FormFieldComponent {
  @Input() label = '';
  @Input() control!: FormControl;
  @Input() type = 'text';
  @Input() placeholder = '';
  @Input() required = false;
  @Input() errorMessages: { [key: string]: string } = {};

  get showError(): boolean {
    return this.control && this.control.invalid && this.control.touched;
  }

  get errorMessage(): string {
    if (!this.control || !this.control.errors) return '';

    const errors = this.control.errors;

    for (const errorKey of Object.keys(errors)) {
      if (this.errorMessages[errorKey]) {
        return this.errorMessages[errorKey];
      }
    }

    // Default error messages
    if (errors['required']) return `${this.label} is required`;
    if (errors['email']) return 'Invalid email address';
    if (errors['minlength']) {
      return `Minimum length is ${errors['minlength'].requiredLength}`;
    }
    if (errors['maxlength']) {
      return `Maximum length is ${errors['maxlength'].requiredLength}`;
    }

    return 'Invalid value';
  }
}
