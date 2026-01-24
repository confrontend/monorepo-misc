import { NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

export async function POST(request: Request) {
  try {
    const { folderPath } = await request.json();

    if (!folderPath) {
      return NextResponse.json(
        { error: 'Folder path is required' },
        { status: 400 }
      );
    }

    // Read all files from the directory
    const files = await readdir(folderPath);
    
    // Filter for transcription files (containing "transcribed on" in filename)
    const transcriptionFiles = files.filter(file => 
      file.includes('transcribed on') && file.endsWith('.txt')
    );

    if (transcriptionFiles.length === 0) {
      return NextResponse.json(
        { error: 'No transcription files found in the specified folder' },
        { status: 404 }
      );
    }

    // Sort files alphabetically for consistent ordering
    transcriptionFiles.sort();

    // Aggregate transcriptions
    let aggregatedContent = '';
    
    for (const file of transcriptionFiles) {
      // Extract the ID from the filename
      // Format: instagram-reel-17868991110836 (transcribed on 17-Jan-2026 17-20-36).txt
      const idMatch = file.match(/instagram-reel-(\d+)/);
      const id = idMatch ? idMatch[1] : 'unknown';
      
      // Read the file content
      const filePath = join(folderPath, file);
      const content = await readFile(filePath, 'utf-8');
      
      // Add to aggregated content with ID as title
      aggregatedContent += `========================================\n`;
      aggregatedContent += `ID: ${id}\n`;
      aggregatedContent += `File: ${file}\n`;
      aggregatedContent += `========================================\n\n`;
      aggregatedContent += content.trim();
      aggregatedContent += `\n\n\n`;
    }

    // Add summary at the beginning
    const summary = `AGGREGATED TRANSCRIPTIONS\n`;
    const summaryLine = `Total transcriptions: ${transcriptionFiles.length}\n`;
    const dateLine = `Generated: ${new Date().toISOString()}\n`;
    const separator = `${'='.repeat(60)}\n\n`;
    
    const finalContent = summary + summaryLine + dateLine + separator + aggregatedContent;

    // Return as downloadable text file
    return new NextResponse(finalContent, {
      headers: {
        'Content-Type': 'text/plain',
        'Content-Disposition': `attachment; filename="aggregated-transcriptions-${Date.now()}.txt"`,
      },
    });

  } catch (error) {
    console.error('Error aggregating transcriptions:', error);
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to aggregate transcriptions: ${errorMessage}` },
      { status: 500 }
    );
  }
}
