import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HeaderComponent } from '../../layout/header/header.component';
import {
  AllowedUsersService,
  AllowedUser,
} from '../../core/services/allowed-users.service';

@Component({
  selector: 'app-allowed-users',
  standalone: true,
  imports: [CommonModule, FormsModule, HeaderComponent],
  templateUrl: './allowed-users.component.html',
  styleUrl: './allowed-users.component.scss',
})
export class AllowedUsersComponent implements OnInit {
  private allowedUsersService = inject(AllowedUsersService);

  users = signal<AllowedUser[]>([]);
  isLoading = signal(false);
  errorMessage = signal<string | null>(null);
  successMessage = signal<string | null>(null);

  // Add user form
  newUserEmail = signal('');
  isAdding = signal(false);

  // Edit mode
  editingEmail = signal<string | null>(null);
  editedEmail = signal('');

  ngOnInit(): void {
    this.loadUsers();
  }

  loadUsers(): void {
    this.isLoading.set(true);
    this.errorMessage.set(null);

    this.allowedUsersService.getAllowedUsers().subscribe({
      next: (users) => {
        this.users.set(users);
        this.isLoading.set(false);
      },
      error: (error) => {
        this.errorMessage.set(`Failed to load users: ${error.message}`);
        this.isLoading.set(false);
      },
    });
  }

  addUser(): void {
    const email = this.newUserEmail().trim();
    if (!email) {
      this.errorMessage.set('Please enter a valid email address');
      return;
    }

    if (!this.isValidEmail(email)) {
      this.errorMessage.set('Please enter a valid email format');
      return;
    }

    this.isAdding.set(true);
    this.errorMessage.set(null);
    this.successMessage.set(null);

    this.allowedUsersService.addAllowedUser(email).subscribe({
      next: () => {
        this.successMessage.set(`User ${email} added successfully`);
        this.newUserEmail.set('');
        this.isAdding.set(false);
        this.loadUsers();
        setTimeout(() => this.successMessage.set(null), 3000);
      },
      error: (error) => {
        this.errorMessage.set(`Failed to add user: ${error.message}`);
        this.isAdding.set(false);
      },
    });
  }

  startEdit(email: string): void {
    this.editingEmail.set(email);
    this.editedEmail.set(email);
    this.errorMessage.set(null);
    this.successMessage.set(null);
  }

  cancelEdit(): void {
    this.editingEmail.set(null);
    this.editedEmail.set('');
  }

  saveEdit(oldEmail: string): void {
    const newEmail = this.editedEmail().trim();
    if (!newEmail) {
      this.errorMessage.set('Please enter a valid email address');
      return;
    }

    if (!this.isValidEmail(newEmail)) {
      this.errorMessage.set('Please enter a valid email format');
      return;
    }

    this.errorMessage.set(null);
    this.successMessage.set(null);

    this.allowedUsersService.updateAllowedUser(oldEmail, newEmail).subscribe({
      next: () => {
        this.successMessage.set(`User updated successfully`);
        this.editingEmail.set(null);
        this.editedEmail.set('');
        this.loadUsers();
        setTimeout(() => this.successMessage.set(null), 3000);
      },
      error: (error) => {
        this.errorMessage.set(`Failed to update user: ${error.message}`);
      },
    });
  }

  deleteUser(email: string): void {
    if (
      !confirm(`Are you sure you want to remove ${email} from allowed users?`)
    ) {
      return;
    }

    this.errorMessage.set(null);
    this.successMessage.set(null);

    this.allowedUsersService.deleteAllowedUser(email).subscribe({
      next: () => {
        this.successMessage.set(`User ${email} removed successfully`);
        this.loadUsers();
        setTimeout(() => this.successMessage.set(null), 3000);
      },
      error: (error) => {
        this.errorMessage.set(`Failed to delete user: ${error.message}`);
      },
    });
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
}
