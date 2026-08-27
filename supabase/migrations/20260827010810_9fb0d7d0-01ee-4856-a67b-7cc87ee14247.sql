ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS file_path text,
  ADD COLUMN IF NOT EXISTS file_url text,
  ADD COLUMN IF NOT EXISTS file_name text,
  ADD COLUMN IF NOT EXISTS file_type text,
  ADD COLUMN IF NOT EXISTS uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_standard boolean NOT NULL DEFAULT true;

UPDATE public.documents SET done = false WHERE file_path IS NULL;

CREATE POLICY "Open read shipment documents"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'shipment-documents');

CREATE POLICY "Open insert shipment documents"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'shipment-documents');

CREATE POLICY "Open update shipment documents"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (bucket_id = 'shipment-documents')
WITH CHECK (bucket_id = 'shipment-documents');

CREATE POLICY "Open delete shipment documents"
ON storage.objects FOR DELETE
TO anon, authenticated
USING (bucket_id = 'shipment-documents');