use rand::Rng;

/// Characters used for pairing codes — ambiguous characters excluded
/// (0/O, 1/I/L removed to avoid user confusion).
const CHARSET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// Generate an 8-character alphanumeric pairing code.
/// Uses 30 chars × 8 positions = ~6.56 × 10^11 combinations.
pub fn generate_pairing_code() -> String {
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| CHARSET[rng.gen_range(0..CHARSET.len())] as char)
        .collect()
}

/// Validate pairing code format (8 uppercase alphanumeric characters).
pub fn validate_pairing_code(code: &str) -> bool {
    code.len() == 8
        && code
            .bytes()
            .all(|b| CHARSET.contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_pairing_code() {
        let code = generate_pairing_code();
        assert_eq!(code.len(), 8);
        assert!(code.bytes().all(|b| CHARSET.contains(&b)));
    }

    #[test]
    fn test_validate_pairing_code() {
        assert!(validate_pairing_code("ABC234XY"));
        assert!(validate_pairing_code("XYZKMN56"));
        assert!(!validate_pairing_code("ABC234X"));     // too short (7)
        assert!(!validate_pairing_code("ABC234XYZ"));   // too long (9)
        assert!(!validate_pairing_code("abcdefgh"));    // lowercase
        assert!(!validate_pairing_code("AB CD3XY"));    // space
        assert!(!validate_pairing_code("ABCDE0XY"));    // '0' excluded
        assert!(!validate_pairing_code("ABCDE1XY"));    // '1' excluded
        assert!(!validate_pairing_code("ABCDEOXY"));    // 'O' excluded
        assert!(!validate_pairing_code("ABCDEIXY"));    // 'I' excluded
        assert!(!validate_pairing_code("ABCDELXY"));    // 'L' excluded
    }
}
