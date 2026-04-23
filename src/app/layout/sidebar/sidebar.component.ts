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
    { path: '/projects', label: 'Projects', icon: 'pi pi-folder' },
    { path: '/projects/create', label: 'Create Project', icon: 'pi pi-plus' },
    { path: '/settings', label: 'Settings', icon: 'pi pi-cog' },
  ];

  get hasToken(): boolean {
    return this.authService.hasToken();
  }
}
