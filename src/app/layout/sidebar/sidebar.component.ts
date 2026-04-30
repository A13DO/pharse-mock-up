import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { HlmSidebar, HlmSidebarImports } from '@spartan-ng/helm/sidebar';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { HlmIcon } from '@spartan-ng/helm/icon';
import {
  lucideFolder,
  lucideBolt,
  lucideSettings,
  lucideAlertTriangle,
} from '@ng-icons/lucide';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterModule, HlmSidebarImports, NgIcon, HlmIcon],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
  providers: [
    provideIcons({
      lucideFolder,
      lucideBolt,
      lucideSettings,
      lucideAlertTriangle,
    }),
  ],
})
export class SidebarComponent {
  private authService = inject(AuthService);

  menuItems = [
    { path: '/projects', label: 'Projects', icon: 'lucideFolder' },
    { path: '/ai-translate', label: 'AI Translation', icon: 'lucideBolt' },
    { path: '/settings', label: 'Settings', icon: 'lucideSettings' },
  ];
  get hasToken(): boolean {
    return this.authService.hasToken();
  }
}
