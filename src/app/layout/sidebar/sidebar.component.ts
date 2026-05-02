import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { HlmSidebar, HlmSidebarImports } from '@spartan-ng/helm/sidebar';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { HlmIcon } from '@spartan-ng/helm/icon';
import { HlmButton } from '@spartan-ng/helm/button';
import {
  lucideFolder,
  lucideBolt,
  lucideSettings,
  lucideAlertTriangle,
  lucideLogOut,
  lucideUser,
  lucideUsers,
} from '@ng-icons/lucide';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    HlmSidebarImports,
    NgIcon,
    HlmIcon,
    HlmButton,
  ],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
  providers: [
    provideIcons({
      lucideFolder,
      lucideBolt,
      lucideSettings,
      lucideAlertTriangle,
      lucideLogOut,
      lucideUser,
      lucideUsers,
    }),
  ],
})
export class SidebarComponent {
  private authService = inject(AuthService);
  private router = inject(Router);

  menuItems = [
    { path: '/projects', label: 'Projects', icon: 'lucideFolder' },
    // { path: '/ai-translate', label: 'AI Translation', icon: 'lucideBolt' },
    { path: '/allowed-users', label: 'Allowed Users', icon: 'lucideUsers' },
    { path: '/settings', label: 'Settings', icon: 'lucideSettings' },
  ];

  get hasToken(): boolean {
    return this.authService.hasToken();
  }

  get currentUser() {
    return this.authService.getUser();
  }

  logout(): void {
    console.log('🔐 Logging out...');
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
