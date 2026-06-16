/// Truncate `s` to at most `max_chars` Unicode scalar values (chars), appending `…` if truncated.
///
/// Note: counts `char`s, not grapheme clusters — combining sequences (e.g. emoji ZWJ) may split.
pub(crate) fn truncate_str(s: &str, max_chars: usize) -> String {
    let mut chars = s.chars();
    let collected: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{}…", collected)
    } else {
        collected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_string_unchanged() {
        assert_eq!(truncate_str("hello", 10), "hello");
    }

    #[test]
    fn exact_length_unchanged() {
        assert_eq!(truncate_str("hello", 5), "hello");
    }

    #[test]
    fn truncated_gets_ellipsis() {
        assert_eq!(truncate_str("hello world", 5), "hello…");
    }

    #[test]
    fn multibyte_chars_counted_correctly() {
        assert_eq!(truncate_str("안녕하세요", 3), "안녕하…");
        assert_eq!(truncate_str("안녕하세요", 5), "안녕하세요");
    }
}
