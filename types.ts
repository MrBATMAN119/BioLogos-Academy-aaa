
export interface Transcription {
  text: string;
  type: 'user' | 'model';
  timestamp: number;
}

export interface CalendarEvent {
  summary: string;
  description?: string;
  startTime: string;
  endTime: string;
}

export interface BibleVerse {
  reference: string;
  text: string;
}
