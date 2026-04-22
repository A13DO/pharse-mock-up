import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
})
export class SidebarComponent {
  private authService = inject(AuthService);

  menuItems = [
    { path: '/projects', label: 'Projects', icon: '📁' },
    { path: '/projects/create', label: 'Create Project', icon: '➕' },
    { path: '/settings', label: 'Settings', icon: '⚙️' },
  ];

  get hasToken(): boolean {
    return this.authService.hasToken();
  }
}
