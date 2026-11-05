# Release notes

<script>alert('block script')</script>

Inline <script>alert('inline')</script>script tags and <img src=x onerror="alert(1)"> images are dropped; <b>bold tags</b> keep their text.

<iframe src="https://evil.example/frame"></iframe>

Links: [safe](https://example.com/notes), [mail](mailto:team@example.com?subject=Notes), [js](javascript:alert(document.cookie)), [JS upper](JaVaScRiPt:alert(1)), [data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==), [plain http](http://example.com/insecure), [relative](../secrets.txt), [file](file:///etc/passwd).

Autolinks: <https://example.org/auto> and <javascript:alert(2)>.

Reference [style][evil] and [good one][good].

[evil]: javascript:alert(3)
[good]: https://example.net/ref

![remote picture](https://evil.example/track.png) and ![local file](file:///etc/passwd)

<div onclick="alert(4)">

Text inside an HTML block's markdown stays text.

</div>

Emphasis split: x *<script>* alert('em') *</script>* y stays.

- <script>alert('list')</script>
- a list item with an HTML block

  <img src=x onerror=alert(5)>
- <div onclick=alert(6)>hi</div>
- a list item with a [link](javascript:alert(7)) after <script>alert('list inline')</script>its script
