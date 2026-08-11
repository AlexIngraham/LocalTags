from argparse import ArgumentParser
from pathlib import Path

from mutagen.id3 import APIC, ID3, ID3NoHeaderError, TALB, TCON, TIT2, TPE1, TRCK
from mutagen.mp4 import MP4, MP4Cover
from mutagen.mp3 import MP3


def write_tags(
    mp3_path: str,
    title: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    tracknumber: str | None = None,
    genre: str | None = None,
    cover_path: str | None = None,
) -> None:
	path = Path(mp3_path)
	if not path.exists():
		raise FileNotFoundError(f"Audio file not found: {path}")

	cover_data = None
	cover_format = None
	if cover_path is not None:
		cover = Path(cover_path)
		if not cover.exists():
			raise FileNotFoundError(f"Cover image not found: {cover}")
		cover_data = cover.read_bytes()
		cover_format = "jpeg" if cover.suffix.lower() in {".jpg", ".jpeg"} else "png"

	if path.suffix.lower() in {".m4a", ".mp4", ".m4b"}:
		audio = MP4(str(path))
		if audio.tags is None:
			audio.add_tags()

		tags = audio.tags
		if title is not None:
			tags["\xa9nam"] = [str(title)]
		if artist is not None:
			tags["\xa9ART"] = [str(artist)]
		if album is not None:
			tags["\xa9alb"] = [str(album)]
		if tracknumber is not None:
			tags["trkn"] = [(int(tracknumber), 0)]
		if genre is not None:
			tags["\xa9gen"] = [str(genre)]
		if cover_data is not None:
			tags["covr"] = [
				MP4Cover(
					cover_data,
					imageformat=MP4Cover.FORMAT_JPEG if cover_format == "jpeg" else MP4Cover.FORMAT_PNG,
				)
			]
		audio.save()
		return

	try:
		audio = MP3(str(path), ID3=ID3)
	except ID3NoHeaderError:
		audio.add_tags()

	tags = audio.tags
	if title is not None:
		tags["TIT2"] = TIT2(encoding=3, text=str(title))
	if artist is not None:
		tags["TPE1"] = TPE1(encoding=3, text=str(artist))
	if album is not None:
		tags["TALB"] = TALB(encoding=3, text=str(album))
	if tracknumber is not None:
		tags["TRCK"] = TRCK(encoding=3, text=str(tracknumber))
	if genre is not None:
		tags["TCON"] = TCON(encoding=3, text=str(genre))

	if cover_data is not None:
		tags.add(
			APIC(
				encoding=3,
				mime="image/jpeg" if cover_format == "jpeg" else "image/png",
				type=3,
				desc="Cover",
				data=cover_data,
			)
		)

	audio.save()


def main() -> None:
	parser = ArgumentParser(description="Write metadata and cover art to an audio file with Mutagen.")
	parser.add_argument("mp3_path", help="/Users/alexingraham/Downloads/spotfy/Monkeys.m4a")
	parser.add_argument("--title", default="Second Arrangement")
	parser.add_argument("--artist", default="Steely Dan")
	parser.add_argument("--album", default=None)
	parser.add_argument("--tracknumber", default=None)
	parser.add_argument("--genre", default=None)
	parser.add_argument("--cover", default=None)
	args = parser.parse_args()

	write_tags(
		args.mp3_path,
		title=args.title,
		artist=args.artist,
		album=args.album,
		tracknumber=args.tracknumber,
		genre=args.genre,
		cover_path=args.cover,
	)


if __name__ == "__main__":
	main()


# python main.py ~/Music/mysong.mp3 --title "Bohemian Rhapsody" --artist 
# "Queen" --album "A Night at the Opera" --cover ~/Music/cover.jpg
