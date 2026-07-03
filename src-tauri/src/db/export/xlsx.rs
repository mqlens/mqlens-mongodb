//! Streaming .xlsx export via rust_xlsxwriter. Scalars map to native Excel
//! cell types; sub-documents/arrays serialize as JSON strings. Column widths
//! are tracked manually so auto-size works without buffering all rows twice.

use super::json::doc_to_json_string;
use super::options::{lookup_path, JsonMode, XlsxAlign, XlsxOptions};
use mongodb::bson::{Bson, Document};
use rust_xlsxwriter::{Format, FormatAlign, Workbook, Worksheet};

const MAX_AUTO_WIDTH: f64 = 60.0;

pub struct XlsxSink {
    workbook: Workbook,
    path: String,
    columns: Vec<String>,
    opts: XlsxOptions,
    next_row: u32,
    /// Max character count seen per column, for auto-size.
    widths: Vec<usize>,
    cell_format: Format,
    date_format: Format,
}

fn alignment(align: XlsxAlign) -> FormatAlign {
    match align {
        XlsxAlign::Left => FormatAlign::Left,
        XlsxAlign::Center => FormatAlign::Center,
        XlsxAlign::Right => FormatAlign::Right,
    }
}

impl XlsxSink {
    pub fn new(path: &str, columns: Vec<String>, opts: XlsxOptions) -> Result<XlsxSink, String> {
        let mut workbook = Workbook::new();
        workbook.push_worksheet(Worksheet::new());
        let align = alignment(opts.alignment);
        let cell_format = Format::new().set_align(align);
        let date_format = Format::new()
            .set_align(align)
            .set_num_format("yyyy-mm-dd hh:mm:ss");
        let mut sink = XlsxSink {
            workbook,
            path: path.to_string(),
            widths: columns.iter().map(|c| c.chars().count()).collect(),
            columns,
            opts,
            next_row: 0,
            cell_format,
            date_format,
        };
        if sink.opts.include_headers {
            let mut header = Format::new().set_align(align);
            if sink.opts.bold_headers {
                header = header.set_bold();
            }
            let ws = sink
                .workbook
                .worksheet_from_index(0)
                .map_err(|e| format!("Excel write error: {}", e))?;
            for (col, name) in sink.columns.iter().enumerate() {
                ws.write_string_with_format(0, col as u16, name, &header)
                    .map_err(|e| format!("Excel write error: {}", e))?;
            }
            sink.next_row = 1;
        }
        Ok(sink)
    }

    fn worksheet(&mut self) -> Result<&mut Worksheet, String> {
        self.workbook
            .worksheet_from_index(0)
            .map_err(|e| format!("Excel write error: {}", e))
    }

    pub fn write_row(&mut self, doc: &Document) -> Result<(), String> {
        let row = self.next_row;
        let mut width_updates: Vec<(usize, usize)> = Vec::with_capacity(self.columns.len());
        {
            let ws = self
                .workbook
                .worksheet_from_index(0)
                .map_err(|e| format!("Excel write error: {}", e))?;
            for (idx, path) in self.columns.iter().enumerate() {
                let col = idx as u16;
                let mut width = 0usize;
                let err = |e| format!("Excel write error: {}", e);
                match lookup_path(doc, path) {
                    None | Some(Bson::Null) => {}
                    Some(Bson::String(s)) => {
                        width = s.chars().count();
                        ws.write_string_with_format(row, col, s, &self.cell_format)
                            .map_err(err)?;
                    }
                    Some(Bson::Int32(n)) => {
                        width = n.to_string().len();
                        ws.write_number_with_format(row, col, *n as f64, &self.cell_format)
                            .map_err(err)?;
                    }
                    Some(Bson::Int64(n)) => {
                        width = n.to_string().len();
                        ws.write_number_with_format(row, col, *n as f64, &self.cell_format)
                            .map_err(err)?;
                    }
                    Some(Bson::Double(n)) => {
                        width = n.to_string().len();
                        ws.write_number_with_format(row, col, *n, &self.cell_format)
                            .map_err(err)?;
                    }
                    Some(Bson::Boolean(b)) => {
                        width = 5;
                        ws.write_boolean_with_format(row, col, *b, &self.cell_format)
                            .map_err(err)?;
                    }
                    Some(Bson::DateTime(dt)) => {
                        width = 19;
                        let excel_dt = rust_xlsxwriter::ExcelDateTime::from_timestamp(
                            dt.timestamp_millis().div_euclid(1000),
                        )
                        .map_err(|e| format!("Excel date error: {}", e))?;
                        ws.write_datetime_with_format(row, col, &excel_dt, &self.date_format)
                            .map_err(err)?;
                    }
                    Some(Bson::ObjectId(oid)) => {
                        let hex = oid.to_hex();
                        width = hex.len();
                        ws.write_string_with_format(row, col, &hex, &self.cell_format)
                            .map_err(err)?;
                    }
                    Some(Bson::Document(sub)) => {
                        let s = doc_to_json_string(sub, JsonMode::Relaxed)?;
                        width = s.chars().count();
                        ws.write_string_with_format(row, col, &s, &self.cell_format)
                            .map_err(err)?;
                    }
                    Some(other) => {
                        let value = other.clone().into_relaxed_extjson();
                        let s = serde_json::to_string(&value).unwrap_or_default();
                        width = s.chars().count();
                        ws.write_string_with_format(row, col, &s, &self.cell_format)
                            .map_err(err)?;
                    }
                }
                width_updates.push((idx, width));
            }
        }
        for (idx, width) in width_updates {
            if width > self.widths[idx] {
                self.widths[idx] = width;
            }
        }
        self.next_row = row + 1;
        Ok(())
    }

    pub fn finish(mut self) -> Result<(), String> {
        if self.opts.auto_size {
            let widths = self.widths.clone();
            let ws = self.worksheet()?;
            for (idx, chars) in widths.iter().enumerate() {
                let w = ((*chars as f64) + 2.0).min(MAX_AUTO_WIDTH);
                ws.set_column_width(idx as u16, w)
                    .map_err(|e| format!("Excel write error: {}", e))?;
            }
        }
        self.workbook
            .save(&self.path)
            .map_err(|e| format!("Failed to write Excel file: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::export::options::XlsxOptions;
    use mongodb::bson::{doc, DateTime};

    #[test]
    fn writes_a_valid_xlsx_file_with_rows() {
        let path = std::env::temp_dir().join(format!(
            "mqlens-xlsx-test-{}-{}.xlsx",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path_str = path.to_string_lossy().to_string();
        let mut opts = XlsxOptions::default();
        opts.bold_headers = true;
        opts.auto_size = true;

        let mut sink = XlsxSink::new(
            &path_str,
            vec![
                "name".into(),
                "n".into(),
                "ok".into(),
                "when".into(),
                "addr.city".into(),
            ],
            opts,
        )
        .unwrap();
        sink.write_row(&doc! {"name": "Alice", "n": 42i64, "ok": true,
        "when": DateTime::from_millis(0),
        "addr": {"city": "Pune"}})
            .unwrap();
        sink.write_row(&doc! {"name": "Bob"}).unwrap();
        sink.finish().unwrap();

        let bytes = std::fs::read(&path).expect("file exists");
        assert!(bytes.len() > 500, "non-trivial file");
        assert_eq!(&bytes[..2], b"PK", "xlsx is a zip container");
        let _ = std::fs::remove_file(&path);
    }
}
