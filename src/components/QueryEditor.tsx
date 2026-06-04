import React, { useRef } from 'react';
import Editor, { type Monaco } from '@monaco-editor/react';
import { registerMongoCompletionProvider, setModelMeta, clearModelMeta } from '../lib/monacoMongo';
import type { Surface } from '../lib/mongoCompletions';
import type { SchemaMap } from '../lib/useCollectionSchema';

interface QueryEditorProps {
  surface: Surface;
  value: string;
  onChange: (v: string) => void;
  fields: string[];
  schema?: SchemaMap;
  height?: number | string;
}

export const QueryEditor: React.FC<QueryEditorProps> = ({ surface, value, onChange, fields, schema, height = 120 }) => {
  const fieldsRef = useRef(fields); fieldsRef.current = fields;
  const schemaRef = useRef(schema); schemaRef.current = schema;
  const uriRef = useRef<string | null>(null);
  const theme = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'vs-dark';

  return (
    <Editor
      height={height}
      defaultLanguage="json"
      theme={theme}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={(editor, monaco: Monaco) => {
        registerMongoCompletionProvider(monaco);
        const model = editor.getModel();
        if (model) {
          uriRef.current = model.uri.toString();
          setModelMeta(uriRef.current, {
            surface,
            getFields: () => fieldsRef.current,
            getSchema: () => schemaRef.current,
          });
          editor.onDidDispose(() => { if (uriRef.current) clearModelMeta(uriRef.current); });
        }
      }}
      options={{
        minimap: { enabled: false }, lineNumbers: 'off', folding: false,
        scrollBeyondLastLine: false, wordWrap: 'on', fontSize: 12,
        scrollbar: { vertical: 'auto', horizontal: 'auto' }, overviewRulerLanes: 0,
        renderLineHighlight: 'none', tabSize: 2,
      }}
    />
  );
};
