fn main() {
    let mut s: u64 = 0;
    let mut i: u64 = 0;
    while i < 300000 {
        s = s.wrapping_add(i * i % 7);
        i += 1;
    }
    println!("{s}");
}
