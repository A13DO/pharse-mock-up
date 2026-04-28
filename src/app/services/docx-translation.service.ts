import { Injectable } from '@angular/core';
import * as mammoth from 'mammoth';
import { Document, Paragraph, TextRun, HeadingLevel, Packer } from 'docx';

export type Provider = 'anthropic' | 'openai' | 'gemini';

interface ProviderConfig {
  url: string;
  buildRequest: (
    text: string,
    prompt: string,
    apiKey: string,
  ) => {
    url: string;
    headers: Record<string, string>;
    body: any;
  };
  extractResponse: (data: any) => string;
}

@Injectable({
  providedIn: 'root',
})
export class DocxTranslationService {
  private providerConfigs: Record<Provider, ProviderConfig> = {
    anthropic: {
      url: 'https://api.anthropic.com/v1/messages',
      buildRequest: (text: string, prompt: string, apiKey: string) => ({
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8192,
          system: prompt,
          messages: [
            {
              role: 'user',
              content: text,
            },
          ],
        },
      }),
      extractResponse: (data: any) => data.content[0].text,
    },
    openai: {
      url: 'https://api.openai.com/v1/chat/completions',
      buildRequest: (text: string, prompt: string, apiKey: string) => ({
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model: 'gpt-4o',
          max_tokens: 8192,
          messages: [
            {
              role: 'system',
              content: prompt,
            },
            {
              role: 'user',
              content: text,
            },
          ],
        },
      }),
      extractResponse: (data: any) => data.choices[0].message.content,
    },
    gemini: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
      buildRequest: (text: string, prompt: string, apiKey: string) => ({
        url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`,
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          contents: [
            {
              parts: [{ text }],
            },
          ],
          systemInstruction: {
            parts: [{ text: prompt }],
          },
        },
      }),
      extractResponse: (data: any) => data.candidates[0].content.parts[0].text,
    },
  };

  /**
   * Translate a DOCX document using the specified AI provider
   */
  async translateDocument(
    file: File,
    customPrompt: string,
    provider: Provider,
    apiKey: string,
  ): Promise<{ blob: Blob; filename: string }> {
    console.log('🚀 Starting document translation...');
    console.log('Provider:', provider);
    console.log('File:', file.name, file.size, 'bytes');

    // Step 1: Extract text from DOCX
    console.log('📖 Step 1: Extracting text from DOCX...');
    const extractedText = await this.extractTextFromDocx(file);
    console.log('✅ Extracted', extractedText.length, 'characters');

    // Step 2: Call AI provider
    console.log('🤖 Step 2: Calling', provider, 'API...');
    const translatedText = await this.callAIProvider(
      extractedText,
      customPrompt,
      provider,
      apiKey,
    );
    console.log(
      '✅ Received translation:',
      translatedText.length,
      'characters',
    );

    // Step 3: Build new DOCX with formatting
    console.log('📝 Step 3: Building DOCX with formatting...');
    const blob = await this.buildDocx(translatedText);
    console.log('✅ DOCX created');

    const originalName = file.name.replace('.docx', '');
    const filename = `${originalName}_translated_${provider}.docx`;

    return { blob, filename };
  }

  /**
   * Extract raw text from DOCX file
   */
  private async extractTextFromDocx(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = async (e) => {
        try {
          const arrayBuffer = e.target?.result as ArrayBuffer;
          const result = await mammoth.extractRawText({ arrayBuffer });
          resolve(result.value);
        } catch (error) {
          reject(new Error('Failed to extract text from DOCX'));
        }
      };

      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Call the AI provider API
   */
  private async callAIProvider(
    text: string,
    prompt: string,
    provider: Provider,
    apiKey: string,
  ): Promise<string> {
    const config = this.providerConfigs[provider];
    const request = config.buildRequest(text, prompt, apiKey);

    console.log('📤 Request URL:', request.url);

    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
      });

      console.log('📥 Response status:', response.status);

      if (!response.ok) {
        let errorMessage = `${provider} API error: ${response.status} ${response.statusText}`;

        try {
          const errorData = await response.json();
          console.error('Error details:', errorData);

          // Provider-specific error messages
          if (provider === 'anthropic' && errorData.error) {
            errorMessage = `Anthropic API error: ${errorData.error.message || errorData.error.type}`;
          } else if (provider === 'openai' && errorData.error) {
            errorMessage = `OpenAI API error: ${errorData.error.message}`;
          } else if (provider === 'gemini' && errorData.error) {
            errorMessage = `Gemini API error: ${errorData.error.message}`;
          }

          // Add hint for authentication errors
          if (response.status === 401 || response.status === 403) {
            errorMessage += ' (Check your API key)';
          }
        } catch (e) {
          console.error('Could not parse error response');
        }

        throw new Error(errorMessage);
      }

      const data = await response.json();
      const translatedText = config.extractResponse(data);

      if (!translatedText) {
        throw new Error(
          `Failed to extract translation from ${provider} response`,
        );
      }

      return translatedText;
    } catch (error: any) {
      if (error.message.includes('API error')) {
        throw error;
      }
      throw new Error(`Network error calling ${provider}: ${error.message}`);
    }
  }

  /**
   * Build a DOCX file from markdown-style text
   * Preserves # H1, ## H2, ### H3, **bold**
   */
  private async buildDocx(text: string): Promise<Blob> {
    const lines = text.split('\n');
    const children: Paragraph[] = [];

    for (let line of lines) {
      line = line.trim();

      if (!line) {
        // Empty line
        children.push(new Paragraph({ text: '' }));
        continue;
      }

      // Check for headings
      if (line.startsWith('### ')) {
        children.push(
          new Paragraph({
            text: line.substring(4),
            heading: HeadingLevel.HEADING_3,
          }),
        );
      } else if (line.startsWith('## ')) {
        children.push(
          new Paragraph({
            text: line.substring(3),
            heading: HeadingLevel.HEADING_2,
          }),
        );
      } else if (line.startsWith('# ')) {
        children.push(
          new Paragraph({
            text: line.substring(2),
            heading: HeadingLevel.HEADING_1,
          }),
        );
      } else {
        // Regular paragraph with bold support
        children.push(this.parseParagraphWithBold(line));
      }
    }

    const doc = new Document({
      sections: [
        {
          children,
        },
      ],
    });

    const blob = await Packer.toBlob(doc);
    return blob;
  }

  /**
   * Parse a line and create a paragraph with bold formatting
   */
  private parseParagraphWithBold(line: string): Paragraph {
    const parts: TextRun[] = [];
    const boldRegex = /\*\*(.*?)\*\*/g;
    let lastIndex = 0;
    let match;

    while ((match = boldRegex.exec(line)) !== null) {
      // Add text before the bold part
      if (match.index > lastIndex) {
        parts.push(new TextRun(line.substring(lastIndex, match.index)));
      }

      // Add bold text
      parts.push(new TextRun({ text: match[1], bold: true }));

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < line.length) {
      parts.push(new TextRun(line.substring(lastIndex)));
    }

    // If no bold parts found, just add the whole line
    if (parts.length === 0) {
      parts.push(new TextRun(line));
    }

    return new Paragraph({ children: parts });
  }
}
