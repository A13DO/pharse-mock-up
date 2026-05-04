import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import {
  HlmBreadcrumb,
  HlmBreadcrumbItem,
  HlmBreadcrumbLink,
  HlmBreadcrumbList,
  HlmBreadcrumbPage,
  HlmBreadcrumbSeparator,
} from '@spartan-ng/helm/breadcrumb';
import { HlmSidebarTrigger } from '@spartan-ng/helm/sidebar';

export interface BreadcrumbItem {
  label: string;
  link?: string;
  isCurrentPage?: boolean;
}

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    HlmBreadcrumb,
    HlmBreadcrumbItem,
    HlmBreadcrumbLink,
    HlmBreadcrumbList,
    HlmBreadcrumbPage,
    HlmBreadcrumbSeparator,
    HlmSidebarTrigger,
  ],
  templateUrl: './header.component.html',
  styleUrl: './header.component.scss',
})
export class HeaderComponent {
  currentDate = new Date();
  breadcrumbs = input<BreadcrumbItem[]>([]);
}
