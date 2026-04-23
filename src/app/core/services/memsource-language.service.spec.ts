import { TestBed } from '@angular/core/testing';
import {
  HttpClientTestingModule,
  HttpTestingController,
} from '@angular/common/http/testing';
import {
  MemsourceLanguageService,
  LanguagesResponse,
  Language,
} from './memsource-language.service';

describe('MemsourceLanguageService', () => {
  let service: MemsourceLanguageService;
  let httpMock: HttpTestingController;

  const mockLanguagesResponse: LanguagesResponse = {
    languages: [
      {
        code: 'en',
        name: 'English',
        rfc: 'en',
        android: 'en',
        androidBcp: 'en',
      },
      {
        code: 'ar',
        name: 'Arabic',
        rfc: 'ar',
        android: 'ar',
        androidBcp: 'ar',
      },
    ],
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [MemsourceLanguageService],
    });

    service = TestBed.inject(MemsourceLanguageService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should fetch languages successfully', () => {
    service.getLanguages().subscribe((response) => {
      expect(response.languages.length).toBe(2);
      expect(response.languages[0].code).toBe('en');
      expect(response.languages[1].code).toBe('ar');
    });

    const req = httpMock.expectOne(
      'https://cloud.memsource.com/web/api2/v1/languages',
    );
    expect(req.request.method).toBe('GET');
    req.flush(mockLanguagesResponse);
  });

  it('should handle errors when fetching languages', () => {
    service.getLanguages().subscribe(
      () => {},
      (error) => {
        expect(error).toBeTruthy();
      },
    );

    const req = httpMock.expectOne(
      'https://cloud.memsource.com/web/api2/v1/languages',
    );
    req.error(new ErrorEvent('Network error'));
  });

  it('should find language by code', () => {
    service.getLanguageByCode('en').subscribe((language) => {
      expect(language).toBeTruthy();
      expect(language?.code).toBe('en');
      expect(language?.name).toBe('English');
    });

    const req = httpMock.expectOne(
      'https://cloud.memsource.com/web/api2/v1/languages',
    );
    req.flush(mockLanguagesResponse);
  });

  it('should return undefined if language code not found', () => {
    service.getLanguageByCode('xx').subscribe((language) => {
      expect(language).toBeUndefined();
    });

    const req = httpMock.expectOne(
      'https://cloud.memsource.com/web/api2/v1/languages',
    );
    req.flush(mockLanguagesResponse);
  });

  it('should be case-insensitive when searching by code', () => {
    service.getLanguageByCode('EN').subscribe((language) => {
      expect(language).toBeTruthy();
      expect(language?.code).toBe('en');
    });

    const req = httpMock.expectOne(
      'https://cloud.memsource.com/web/api2/v1/languages',
    );
    req.flush(mockLanguagesResponse);
  });
});
